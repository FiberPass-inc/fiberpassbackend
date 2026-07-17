import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { type NwcExecutionMode, type NwcMethod, type NwcNetwork } from '../domain/nwc.js';
import {
  asAssetId,
  moneyValue,
  PAYMENT_CONTRACT_VERSION,
  type PaymentIntent,
  type PaymentQuote,
  type PaymentResult
} from '../domain/payment.js';
import { ApiError } from '../lib/errors.js';
import { asAtomicAmount, atomicAmountFromBigInt, parseAtomicAmount } from '../lib/money.js';
import { NwcConnectionModel, NwcPaymentModel, type NwcConnectionRecord } from '../models/nwc.model.js';
import { decryptNwcSecret } from '../services/nwcCredential.service.js';
import type {
  ConnectorCapability,
  ConnectorExecutionContext,
  ConnectorLookupInput,
  PaymentConnector
} from './paymentConnector.js';
import { decodeLightningInvoice, verifyLightningPreimage } from './nwcProtocol.js';
import {
  NwcRelayTransport,
  NwcRequestTimeoutError,
  type NwcResponsePayload,
  type NwcTransportResponse
} from './nwcRelayTransport.js';

const BTC_ASSET_ID = asAssetId('bitcoin:btc');
const EXECUTION_MODES = new Set<NwcExecutionMode>(['interactive', 'unattended']);

const REMOTE_ERROR_MESSAGES: Record<string, string> = {
  RATE_LIMITED: 'NWC wallet rate limit was reached.',
  NOT_IMPLEMENTED: 'NWC wallet does not implement the requested capability.',
  INSUFFICIENT_BALANCE: 'NWC wallet has insufficient Lightning balance.',
  QUOTA_EXCEEDED: 'NWC wallet allowance was exceeded.',
  RESTRICTED: 'NWC connection is restricted from this operation.',
  UNAUTHORIZED: 'NWC connection is no longer authorized by the wallet.',
  INTERNAL: 'NWC wallet reported an internal failure.',
  UNSUPPORTED_ENCRYPTION: 'NWC wallet rejected the negotiated encryption scheme.',
  PAYMENT_FAILED: 'NWC wallet could not confirm the Lightning payment.',
  NOT_FOUND: 'NWC wallet did not find the Lightning payment.',
  OTHER: 'NWC wallet rejected the request.'
};

export class NwcRemoteError extends Error {
  constructor(public readonly remoteCode: string) {
    super(REMOTE_ERROR_MESSAGES[remoteCode] ?? REMOTE_ERROR_MESSAGES.OTHER);
  }
}

function quoteId(intent: PaymentIntent, invoiceHash: string): string {
  return 'quote_nwc_' + createHash('sha256').update(intent.intentId + ':' + invoiceHash).digest('hex').slice(0, 24);
}

function metadataString(context: ConnectorExecutionContext | undefined, key: string): string | undefined {
  const value = context?.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function exactAtomic(value: unknown, field: string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new ApiError(502, 'NWC_RESPONSE_INVALID', 'NWC wallet returned an invalid ' + field + '.');
    return value.toString(10);
  }
  if (typeof value === 'string') {
    try {
      return asAtomicAmount(value);
    } catch {
      throw new ApiError(502, 'NWC_RESPONSE_INVALID', 'NWC wallet returned an invalid ' + field + '.');
    }
  }
  throw new ApiError(502, 'NWC_RESPONSE_INVALID', 'NWC wallet omitted ' + field + '.');
}

function requiredString(result: Record<string, unknown> | null, field: string): string {
  const value = result?.[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new ApiError(502, 'NWC_RESPONSE_INVALID', 'NWC wallet omitted ' + field + '.');
  }
  return value.trim().toLowerCase();
}

function ensureRemoteSuccess(response: NwcResponsePayload): Record<string, unknown> {
  if (response.error) throw new NwcRemoteError(response.error.code);
  if (!response.result) throw new ApiError(502, 'NWC_RESPONSE_INVALID', 'NWC wallet returned no result.');
  return response.result;
}

interface LoadedNwcConnection {
  record: NwcConnectionRecord;
  secret: Uint8Array;
}

export class NwcConnector implements PaymentConnector {
  readonly id = 'nwc-nip47';

  constructor(private readonly transport = new NwcRelayTransport({
    timeoutMs: env.NWC_REQUEST_TIMEOUT_MS,
    allowInsecureLocal: env.NWC_ALLOW_INSECURE_LOCAL_RELAY
  })) {}

  capabilities(): readonly ConnectorCapability[] {
    const funding = [{
      mode: 'connected_wallet' as const,
      guarantee: 'authorization_only' as const,
      requiresNetworkProof: false,
      supportsExecution: true,
      balanceSource: 'external_wallet' as const,
      failureStates: [
        'NWC_CAPABILITY_NOT_ADVERTISED',
        'NWC_WALLET_BALANCE_UNVERIFIED',
        'NWC_WALLET_BALANCE_STALE',
        'NWC_UNATTENDED_ALLOWANCE_REQUIRED',
        'NWC_PAYMENT_OUTCOME_UNCERTAIN'
      ]
    }];
    return (['mainnet', 'testnet', 'signet', 'regtest'] as const).map((network) => ({
      connectorId: this.id,
      rail: 'lightning' as const,
      network,
      assetId: BTC_ASSET_ID,
      destinationKinds: ['invoice' as const],
      supportsLookup: true,
      supportsRefund: false,
      funding
    }));
  }

  async validateDestination(intent: PaymentIntent): Promise<void> {
    if (intent.rail !== 'lightning' || intent.destination.kind !== 'invoice' || intent.money.assetId !== BTC_ASSET_ID) {
      throw new ApiError(400, 'NWC_PAYMENT_INTENT_UNSUPPORTED', 'NWC supports BOLT11 Lightning BTC invoices only.');
    }
    decodeLightningInvoice({
      invoice: intent.destination.value,
      network: intent.network as NwcNetwork,
      expectedAmountAtomic: intent.money.amountAtomic
    });
  }

  async quote(intent: PaymentIntent): Promise<PaymentQuote> {
    await this.validateDestination(intent);
    const invoice = decodeLightningInvoice({
      invoice: intent.destination.value,
      network: intent.network as NwcNetwork,
      expectedAmountAtomic: intent.money.amountAtomic
    });
    return {
      quoteId: quoteId(intent, invoice.invoiceHash),
      intentId: intent.intentId,
      connectorId: this.id,
      amount: intent.money,
      fee: moneyValue(BTC_ASSET_ID, '0'),
      total: intent.money,
      expiresAt: invoice.expiresAt,
      metadata: {
        contractVersion: PAYMENT_CONTRACT_VERSION,
        paymentHash: invoice.paymentHash,
        invoiceHash: invoice.invoiceHash,
        payeeNodeKey: invoice.payeeNodeKey
      }
    };
  }

  private async loadConnection(input: {
    connectionId: string;
    ownerWalletId?: string;
    mode: NwcExecutionMode;
    method: NwcMethod;
  }): Promise<LoadedNwcConnection> {
    const connection = await NwcConnectionModel.findOne({
      connectionId: input.connectionId,
      ...(input.ownerWalletId ? { ownerWalletId: input.ownerWalletId } : {}),
      status: 'active'
    }).select('+secretCiphertext').lean<NwcConnectionRecord | null>();
    if (!connection) throw new ApiError(404, 'NWC_CONNECTION_NOT_FOUND', 'Active NWC connection was not found.');
    if (!connection.methods.includes(input.method)) {
      throw new ApiError(409, 'NWC_CAPABILITY_NOT_ADVERTISED', 'NWC wallet did not advertise ' + input.method + '.');
    }
    if (input.mode === 'unattended' && (
      connection.executionMode !== 'unattended'
      || !connection.allowanceEnforced
      || parseAtomicAmount(connection.allowanceAtomic) <= parseAtomicAmount(connection.allowanceUsedAtomic)
      || !connection.allowanceProofEventId
    )) {
      throw new ApiError(409, 'NWC_UNATTENDED_ALLOWANCE_REQUIRED', 'Cloud unattended execution requires a wallet-enforced allowance proof.');
    }
    return { record: connection, secret: decryptNwcSecret(connection.secretCiphertext) };
  }

  private async request(input: {
    connectionId: string;
    ownerWalletId?: string;
    mode: NwcExecutionMode;
    method: NwcMethod;
    params: Record<string, unknown>;
  }): Promise<{ connection: NwcConnectionRecord; transport: NwcTransportResponse }> {
    const loaded = await this.loadConnection(input);
    try {
      const response = await this.transport.request({
        relay: loaded.record.selectedRelay,
        walletPubkey: loaded.record.walletPubkey,
        clientPubkey: loaded.record.clientPubkey,
        secret: loaded.secret,
        encryption: loaded.record.encryption,
        payload: { method: input.method, params: input.params }
      });
      await NwcConnectionModel.updateOne(
        { connectionId: loaded.record.connectionId },
        { $set: { lastUsedAt: new Date() }, $unset: { lastFailureCode: 1, lastFailureMessage: 1 } }
      );
      return { connection: loaded.record, transport: response };
    } catch (error) {
      if (!(error instanceof NwcRequestTimeoutError)) {
        await NwcConnectionModel.updateOne(
          { connectionId: loaded.record.connectionId },
          { $set: { lastFailureCode: error instanceof NwcRemoteError ? error.remoteCode : 'NWC_REQUEST_FAILED', lastFailureMessage: 'NWC request failed.' } }
        );
      }
      throw error;
    } finally {
      loaded.secret.fill(0);
    }
  }

  async execute(intent: PaymentIntent, quote: PaymentQuote, context?: ConnectorExecutionContext): Promise<PaymentResult> {
    const connectionId = metadataString(context, 'nwcConnectionId');
    const modeValue = metadataString(context, 'nwcExecutionMode') ?? 'interactive';
    if (!connectionId || !EXECUTION_MODES.has(modeValue as NwcExecutionMode)) {
      throw new ApiError(400, 'NWC_EXECUTION_CONTEXT_REQUIRED', 'NWC execution requires a scoped connection and mode.');
    }
    const invoice = decodeLightningInvoice({
      invoice: intent.destination.value,
      network: intent.network as NwcNetwork,
      expectedAmountAtomic: intent.money.amountAtomic
    });
    if (
      quote.connectorId !== this.id
      || quote.quoteId !== quoteId(intent, invoice.invoiceHash)
      || quote.metadata?.paymentHash !== invoice.paymentHash
      || Date.parse(quote.expiresAt) <= Date.now()
    ) {
      throw new ApiError(409, 'NWC_QUOTE_INVALID', 'NWC quote is invalid, changed, or expired.');
    }
    const requested = await this.request({
      connectionId,
      ownerWalletId: context?.ownerWalletId,
      mode: modeValue as NwcExecutionMode,
      method: 'pay_invoice',
      params: { invoice: invoice.invoice }
    });
    const result = ensureRemoteSuccess(requested.transport.response);
    const preimage = requiredString(result, 'preimage');
    if (!verifyLightningPreimage(preimage, invoice.paymentHash)) {
      throw new ApiError(502, 'NWC_PAYMENT_PROOF_INVALID', 'NWC wallet payment preimage does not match the invoice.');
    }
    const feeAtomic = result.fees_paid == null ? '0' : exactAtomic(result.fees_paid, 'fees_paid');
    return {
      intentId: intent.intentId,
      status: 'succeeded',
      amount: intent.money,
      connectorId: this.id,
      connectorReference: invoice.paymentHash,
      proof: {
        kind: 'payment_hash',
        reference: invoice.paymentHash,
        network: intent.network,
        observedAt: new Date().toISOString(),
        metadata: {
          requestEventId: requested.transport.requestEventId,
          responseEventId: requested.transport.responseEventId,
          preimageVerified: 'true',
          feeAtomic
        }
      },
      updatedAt: new Date().toISOString()
    };
  }

  async lookup(input: ConnectorLookupInput): Promise<PaymentResult> {
    if (input.rail !== 'lightning' || input.assetId !== BTC_ASSET_ID) {
      throw new ApiError(400, 'NWC_LOOKUP_UNSUPPORTED', 'NWC lookup supports Lightning BTC only.');
    }
    if (!input.ownerWalletId || !input.connectionId) {
      throw new ApiError(400, 'NWC_LOOKUP_CONTEXT_REQUIRED', 'NWC lookup requires wallet owner and connection context.');
    }
    const payment = await NwcPaymentModel.findOne({
      ownerWalletId: input.ownerWalletId,
      connectionId: input.connectionId,
      paymentHash: input.reference.toLowerCase(),
      network: input.network
    }).lean();
    if (!payment) throw new ApiError(404, 'NWC_PAYMENT_NOT_FOUND', 'NWC payment attempt was not found.');
    const requested = await this.request({
      connectionId: payment.connectionId,
      ownerWalletId: payment.ownerWalletId,
      mode: payment.executionMode,
      method: 'lookup_invoice',
      params: { payment_hash: payment.paymentHash }
    });
    if (requested.transport.response.error) {
      return {
        intentId: payment.paymentId,
        status: requested.transport.response.error.code === 'NOT_FOUND' ? 'uncertain' : 'failed',
        amount: moneyValue(BTC_ASSET_ID, payment.amountAtomic),
        connectorId: this.id,
        connectorReference: payment.paymentHash,
        failureCode: 'NWC_' + requested.transport.response.error.code,
        failureMessage: REMOTE_ERROR_MESSAGES[requested.transport.response.error.code] ?? REMOTE_ERROR_MESSAGES.OTHER,
        updatedAt: new Date().toISOString()
      };
    }
    const result = ensureRemoteSuccess(requested.transport.response);
    const responseHash = requiredString(result, 'payment_hash');
    const responseAmount = exactAtomic(result.amount, 'amount');
    if (responseHash !== payment.paymentHash || parseAtomicAmount(responseAmount) !== parseAtomicAmount(payment.amountAtomic)) {
      throw new ApiError(502, 'NWC_LOOKUP_PROOF_MISMATCH', 'NWC lookup result does not match the original payment.');
    }
    const state = typeof result.state === 'string' ? result.state.toLowerCase() : 'pending';
    if (state !== 'settled') {
      return {
        intentId: payment.paymentId,
        status: state === 'failed' || state === 'expired' ? 'failed' : 'pending',
        amount: moneyValue(BTC_ASSET_ID, payment.amountAtomic),
        connectorId: this.id,
        connectorReference: payment.paymentHash,
        failureCode: state === 'failed' || state === 'expired' ? 'NWC_PAYMENT_FAILED' : undefined,
        failureMessage: state === 'failed' || state === 'expired' ? 'NWC wallet reports that the payment failed.' : undefined,
        updatedAt: new Date().toISOString()
      };
    }
    const preimage = requiredString(result, 'preimage');
    if (!verifyLightningPreimage(preimage, payment.paymentHash)) {
      throw new ApiError(502, 'NWC_PAYMENT_PROOF_INVALID', 'NWC lookup preimage does not match the original invoice.');
    }
    const feeAtomic = result.fees_paid == null ? payment.feeAtomic : exactAtomic(result.fees_paid, 'fees_paid');
    return {
      intentId: payment.paymentId,
      status: 'succeeded',
      amount: moneyValue(BTC_ASSET_ID, payment.amountAtomic),
      connectorId: this.id,
      connectorReference: payment.paymentHash,
      proof: {
        kind: 'payment_hash',
        reference: payment.paymentHash,
        network: payment.network,
        observedAt: new Date().toISOString(),
        metadata: {
          requestEventId: requested.transport.requestEventId,
          responseEventId: requested.transport.responseEventId,
          preimageVerified: 'true',
          feeAtomic
        }
      },
      updatedAt: new Date().toISOString()
    };
  }

  async getBalance(connectionId: string, ownerWalletId: string): Promise<{ balanceAtomic: string; responseEventId: string }> {
    const requested = await this.request({
      connectionId,
      ownerWalletId,
      mode: 'interactive',
      method: 'get_balance',
      params: {}
    });
    const result = ensureRemoteSuccess(requested.transport.response);
    return { balanceAtomic: exactAtomic(result.balance, 'balance'), responseEventId: requested.transport.responseEventId };
  }
}

export const nwcConnector = new NwcConnector();

export function nwcFeeAtomic(result: PaymentResult): string {
  return result.proof?.metadata?.feeAtomic ?? atomicAmountFromBigInt(0n);
}
