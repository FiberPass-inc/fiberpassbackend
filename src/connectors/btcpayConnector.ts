import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import type { BitcoinNetwork } from '../domain/bitcoin.js';
import { asAssetId, moneyValue, type PaymentIntent, type PaymentQuote, type PaymentResult } from '../domain/payment.js';
import { ApiError } from '../lib/errors.js';
import { asAtomicAmount } from '../lib/money.js';
import { BtcpayConnectionModel, BtcpayPaymentModel, type BtcpayConnectionRecord } from '../models/bitcoin.model.js';
import { decryptBtcpayApiKey } from '../services/btcpayCredential.service.js';
import type { ConnectorCapability, ConnectorExecutionContext, ConnectorLookupInput, PaymentConnector } from './paymentConnector.js';
import { decodeLightningInvoice, verifyLightningPreimage } from './nwcProtocol.js';
import { BtcpayGreenfieldClient, type BtcpayResponse } from './btcpayClient.js';

const BTC_ASSET_ID = asAssetId('bitcoin:btc');

interface LightningPaymentResponse {
  id?: unknown;
  status?: unknown;
  paymentHash?: unknown;
  preimage?: unknown;
  totalAmount?: unknown;
  feeAmount?: unknown;
}

function quoteId(intent: PaymentIntent, invoiceHash: string): string {
  return 'quote_btcpay_' + createHash('sha256').update(intent.intentId + ':' + invoiceHash).digest('hex').slice(0, 24);
}

function metadataString(context: ConnectorExecutionContext | undefined, key: string): string | undefined {
  const value = context?.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function exactAtomic(value: unknown, field: string): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new ApiError(502, 'BTCPAY_RESPONSE_INVALID', 'BTCPay omitted ' + field + '.');
  }
  try {
    return asAtomicAmount(String(value));
  } catch {
    throw new ApiError(502, 'BTCPAY_RESPONSE_INVALID', 'BTCPay returned an invalid ' + field + '.');
  }
}

function statusResult(input: {
  response: BtcpayResponse<LightningPaymentResponse>;
  intentId: string;
  amountAtomic: string;
  paymentHash: string;
  network: string;
  maxFeeAtomic: string;
}): PaymentResult {
  const body = input.response.body;
  if (!body || typeof body !== 'object') throw new ApiError(502, 'BTCPAY_RESPONSE_INVALID', 'BTCPay returned an invalid Lightning payment response.');
  const responseHash = typeof body.paymentHash === 'string' ? body.paymentHash.toLowerCase() : input.paymentHash;
  if (responseHash !== input.paymentHash) throw new ApiError(502, 'BTCPAY_PAYMENT_PROOF_MISMATCH', 'BTCPay payment hash does not match the invoice.');
  const status = typeof body.status === 'string' ? body.status.toLowerCase() : input.response.status === 202 ? 'unknown' : '';
  const amount = moneyValue(BTC_ASSET_ID, input.amountAtomic);
  if (status === 'complete') {
    const preimage = typeof body.preimage === 'string' ? body.preimage : '';
    if (!verifyLightningPreimage(preimage, input.paymentHash)) {
      throw new ApiError(502, 'BTCPAY_PAYMENT_PROOF_INVALID', 'BTCPay payment preimage does not match the invoice.');
    }
    const feeAtomic = exactAtomic(body.feeAmount ?? '0', 'fee amount');
    if (BigInt(feeAtomic) > BigInt(input.maxFeeAtomic)) throw new ApiError(502, 'BTCPAY_FEE_LIMIT_EXCEEDED', 'BTCPay payment exceeded the reviewed fee limit.');
    if (body.totalAmount != null && BigInt(exactAtomic(body.totalAmount, 'total amount')) !== BigInt(input.amountAtomic) + BigInt(feeAtomic)) {
      throw new ApiError(502, 'BTCPAY_PAYMENT_AMOUNT_MISMATCH', 'BTCPay payment total does not match the invoice and fee.');
    }
    return {
      intentId: input.intentId,
      status: 'succeeded',
      amount,
      connectorId: 'btcpay-greenfield',
      connectorReference: input.paymentHash,
      proof: {
        kind: 'payment_hash',
        reference: input.paymentHash,
        network: input.network,
        observedAt: new Date().toISOString(),
        metadata: {
          preimageVerified: 'true',
          feeAtomic,
          ...(typeof body.id === 'string' ? { providerPaymentId: body.id } : {})
        }
      },
      updatedAt: new Date().toISOString()
    };
  }
  if (['pending', 'unknown'].includes(status) || input.response.status === 202) {
    return {
      intentId: input.intentId,
      status: status === 'unknown' ? 'uncertain' : 'pending',
      amount,
      connectorId: 'btcpay-greenfield',
      connectorReference: input.paymentHash,
      updatedAt: new Date().toISOString()
    };
  }
  return {
    intentId: input.intentId,
    status: 'failed',
    amount,
    connectorId: 'btcpay-greenfield',
    connectorReference: input.paymentHash,
    failureCode: 'BTCPAY_LIGHTNING_PAYMENT_FAILED',
    failureMessage: 'BTCPay reports that the Lightning payment failed.',
    updatedAt: new Date().toISOString()
  };
}

export class BtcpayConnector implements PaymentConnector {
  readonly id = 'btcpay-greenfield';

  constructor(private readonly client = new BtcpayGreenfieldClient({
    timeoutMs: env.BTCPAY_REQUEST_TIMEOUT_MS,
    allowInsecureLocal: env.BTCPAY_ALLOW_INSECURE_LOCAL
  })) {}

  capabilities(): readonly ConnectorCapability[] {
    const funding = [{
      mode: 'connected_wallet' as const,
      guarantee: 'balance_observed' as const,
      requiresNetworkProof: false,
      supportsExecution: true,
      balanceSource: 'connector_channel' as const,
      failureStates: ['BTCPAY_LIGHTNING_UNAVAILABLE', 'BTCPAY_PAYMENT_OUTCOME_UNCERTAIN', 'BTCPAY_FEE_LIMIT_EXCEEDED']
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
      throw new ApiError(400, 'BTCPAY_PAYMENT_INTENT_UNSUPPORTED', 'BTCPay supports BOLT11 Lightning BTC execution only.');
    }
    decodeLightningInvoice({
      invoice: intent.destination.value,
      network: intent.network as BitcoinNetwork,
      expectedAmountAtomic: intent.money.amountAtomic
    });
  }

  async quote(intent: PaymentIntent): Promise<PaymentQuote> {
    await this.validateDestination(intent);
    const invoice = decodeLightningInvoice({
      invoice: intent.destination.value,
      network: intent.network as BitcoinNetwork,
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
      metadata: { paymentHash: invoice.paymentHash, invoiceHash: invoice.invoiceHash }
    };
  }

  private async loadConnection(connectionId: string, ownerWalletId?: string): Promise<{ connection: BtcpayConnectionRecord; apiKey: string }> {
    const connection = await BtcpayConnectionModel.findOne({
      connectionId,
      ...(ownerWalletId ? { ownerWalletId } : {}),
      status: 'active'
    }).select('+apiKeyCiphertext').lean<BtcpayConnectionRecord | null>();
    if (!connection) throw new ApiError(404, 'BTCPAY_CONNECTION_NOT_FOUND', 'Active BTCPay connection was not found.');
    return { connection, apiKey: decryptBtcpayApiKey(connection.apiKeyCiphertext) };
  }

  async execute(intent: PaymentIntent, quote: PaymentQuote, context?: ConnectorExecutionContext): Promise<PaymentResult> {
    const connectionId = metadataString(context, 'btcpayConnectionId');
    const maxFeeAtomic = metadataString(context, 'btcpayMaxFeeAtomic');
    if (!connectionId || !maxFeeAtomic) throw new ApiError(400, 'BTCPAY_EXECUTION_CONTEXT_REQUIRED', 'BTCPay execution requires a scoped connection and fee limit.');
    const invoice = decodeLightningInvoice({
      invoice: intent.destination.value,
      network: intent.network as BitcoinNetwork,
      expectedAmountAtomic: intent.money.amountAtomic
    });
    if (quote.connectorId !== this.id || quote.quoteId !== quoteId(intent, invoice.invoiceHash) || quote.metadata?.paymentHash !== invoice.paymentHash) {
      throw new ApiError(409, 'BTCPAY_QUOTE_INVALID', 'BTCPay quote is invalid or changed.');
    }
    const loaded = await this.loadConnection(connectionId, context?.ownerWalletId);
    const response = await this.client.request<LightningPaymentResponse>({
      serverUrl: loaded.connection.serverOrigin,
      apiKey: loaded.apiKey,
      method: 'POST',
      path: '/api/v1/stores/' + encodeURIComponent(loaded.connection.storeId) + '/lightning/BTC/invoices/pay',
      body: {
        BOLT11: invoice.invoice,
        maxFeeFlat: (BigInt(maxFeeAtomic) / 1000n).toString(10),
        sendTimeout: Math.max(1, Math.floor(env.BTCPAY_REQUEST_TIMEOUT_MS / 1000))
      }
    });
    if (![200, 202].includes(response.status)) throw new ApiError(502, 'BTCPAY_LIGHTNING_PAYMENT_FAILED', 'BTCPay rejected the Lightning payment.');
    return statusResult({
      response,
      intentId: intent.intentId,
      amountAtomic: intent.money.amountAtomic,
      paymentHash: invoice.paymentHash,
      network: intent.network,
      maxFeeAtomic
    });
  }

  async lookup(input: ConnectorLookupInput): Promise<PaymentResult> {
    if (!input.ownerWalletId || !input.connectionId) throw new ApiError(400, 'BTCPAY_LOOKUP_CONTEXT_REQUIRED', 'BTCPay lookup requires wallet and connection context.');
    const payment = await BtcpayPaymentModel.findOne({
      ownerWalletId: input.ownerWalletId,
      connectionId: input.connectionId,
      paymentHash: input.reference.toLowerCase(),
      network: input.network
    }).lean();
    if (!payment) throw new ApiError(404, 'BTCPAY_PAYMENT_NOT_FOUND', 'BTCPay payment attempt was not found.');
    const loaded = await this.loadConnection(input.connectionId, input.ownerWalletId);
    const response = await this.client.request<LightningPaymentResponse>({
      serverUrl: loaded.connection.serverOrigin,
      apiKey: loaded.apiKey,
      method: 'GET',
      path: '/api/v1/stores/' + encodeURIComponent(loaded.connection.storeId) + '/lightning/BTC/payments/' + payment.paymentHash
    });
    if (response.status === 404) {
      return {
        intentId: payment.paymentId,
        status: 'uncertain',
        amount: moneyValue(BTC_ASSET_ID, payment.amountAtomic),
        connectorId: this.id,
        connectorReference: payment.paymentHash,
        updatedAt: new Date().toISOString()
      };
    }
    if (response.status !== 200) throw new ApiError(502, 'BTCPAY_LOOKUP_FAILED', 'BTCPay payment status could not be loaded.');
    return statusResult({
      response,
      intentId: payment.paymentId,
      amountAtomic: payment.amountAtomic,
      paymentHash: payment.paymentHash,
      network: payment.network,
      maxFeeAtomic: payment.maxFeeAtomic
    });
  }
}

export const btcpayConnector = new BtcpayConnector();
