import { createHash } from 'node:crypto';
import {
  PAYMENT_CONTRACT_VERSION,
  asAssetId,
  moneyValue,
  type PaymentIntent,
  type PaymentQuote,
  type PaymentResult
} from '../domain/payment.js';
import { ApiError } from '../lib/errors.js';
import { atomicAmountToLegacySafeNumber, asAtomicAmount } from '../lib/money.js';
import { FIBER_CKB_ADDRESS_ERROR, isFiberCkbAddress } from '../lib/fiberAddress.js';
import { FiberAdapter, fiberAdapter } from '../services/fiberAdapter.js';
import { getFiberNodeReadiness } from '../services/fiberNode.service.js';
import { fiberProvider, type FiberProvider } from '../services/fiberProvider.js';
import { executeVaultPayout, minimalRecipientCapacityMinor } from '../services/vaultPayout.service.js';
import type {
  ConnectorCapability,
  ConnectorExecutionContext,
  ConnectorLookupInput,
  PaymentConnector
} from './paymentConnector.js';

const CKB_ASSET_ID = asAssetId('ckb:ckb');
const PUBLIC_VALIDATION_MESSAGES: Readonly<Record<string, string>> = {
  FIBER_INVOICE_REQUIRED: 'A Fiber invoice/payment request is required.',
  FIBER_INVOICE_INVALID: 'The Fiber invoice/payment request is invalid.',
  FIBER_INVOICE_PARSE_FAILED: 'The Fiber invoice could not be parsed.',
  FIBER_INVOICE_CURRENCY_MISMATCH: 'The Fiber invoice requests an unsupported asset.',
  FIBER_INVOICE_NETWORK_MISMATCH: 'The Fiber invoice belongs to a different network.',
  FIBER_INVOICE_AMOUNT_REQUIRED: 'The Fiber invoice must encode an exact amount.',
  FIBER_INVOICE_AMOUNT_MISMATCH: 'The Fiber invoice amount does not match the payment intent.',
  FIBER_INVOICE_UNSIGNED: 'The Fiber invoice must be signed by its payee.',
  FIBER_INVOICE_EXPIRED: 'The Fiber invoice has expired.',
  CKB_RECIPIENT_AMOUNT_BELOW_MINIMUM: 'The CKB amount is below the destination cell minimum.'
};

function quoteId(intent: PaymentIntent): string {
  return 'quote_' + createHash('sha256').update(JSON.stringify(intent)).digest('hex').slice(0, 24);
}

function sanitizedConnectorError(error: unknown, fallbackCode: string, fallbackMessage: string): ApiError {
  if (error instanceof ApiError && PUBLIC_VALIDATION_MESSAGES[error.code]) {
    return new ApiError(error.statusCode, error.code, PUBLIC_VALIDATION_MESSAGES[error.code]);
  }
  return new ApiError(502, fallbackCode, fallbackMessage);
}

function connectorContext(intent: PaymentIntent, context?: ConnectorExecutionContext) {
  const metadata = { ...(context?.metadata ?? {}) };
  if (intent.destination.kind === 'endpoint') metadata.fiberKeysendTargetPubkey = intent.destination.value;
  return {
    sessionId: context?.sessionId ?? intent.intentId,
    networkSessionId: context?.networkSessionId,
    appAddress: context?.appAddress ?? '',
    amountMinor: atomicAmountToLegacySafeNumber(intent.money.amountAtomic),
    currency: 'CKB',
    paymentRequest: intent.destination.kind === 'invoice' ? intent.destination.value : undefined,
    metadata
  };
}

export class FiberConnector implements PaymentConnector {
  readonly id: string;

  constructor(
    private readonly adapter: FiberAdapter = fiberAdapter,
    private readonly provider: FiberProvider = fiberProvider,
    private readonly vaultPayout: typeof executeVaultPayout = executeVaultPayout
  ) {
    this.id = 'fiber-' + provider.kind;
  }

  capabilities(): readonly ConnectorCapability[] {
    return [
      {
        connectorId: this.id,
        rail: 'fiber',
        network: this.provider.network,
        assetId: CKB_ASSET_ID,
        destinationKinds: ['invoice', 'endpoint'],
        supportsLookup: true,
        supportsRefund: false
      },
      {
        connectorId: this.id,
        rail: 'ckb_onchain',
        network: this.provider.network,
        assetId: CKB_ASSET_ID,
        destinationKinds: ['address'],
        supportsLookup: false,
        supportsRefund: false
      }
    ];
  }

  private validateIntentShape(intent: PaymentIntent): 'ckb_address' | 'fiber_endpoint' | 'fiber_invoice' {
    if (intent.money.assetId !== CKB_ASSET_ID) {
      throw new ApiError(400, 'FIBER_ASSET_UNSUPPORTED', 'The Fiber connector currently supports native CKB only.');
    }
    if (intent.network.trim().toLowerCase() !== this.provider.network.trim().toLowerCase()) {
      throw new ApiError(400, 'PAYMENT_NETWORK_UNSUPPORTED', 'The payment intent targets a different connector network.');
    }
    const amountMinor = atomicAmountToLegacySafeNumber(intent.money.amountAtomic);
    if (amountMinor <= 0) throw new ApiError(400, 'INVALID_PAYMENT_AMOUNT', 'Payment amount must be greater than zero.');
    if (
      intent.destination.rail !== intent.rail
      || intent.destination.network.trim().toLowerCase() !== intent.network.trim().toLowerCase()
    ) {
      throw new ApiError(400, 'PAYMENT_DESTINATION_MISMATCH', 'Payment destination rail and network must match the intent.');
    }

    if (intent.rail === 'ckb_onchain') {
      if (intent.destination.kind !== 'address' || !isFiberCkbAddress(intent.destination.value)) {
        throw new ApiError(400, 'INVALID_RECIPIENT_ADDRESS', FIBER_CKB_ADDRESS_ERROR);
      }
      const minimum = minimalRecipientCapacityMinor(intent.destination.value);
      if (amountMinor < minimum) {
        throw new ApiError(400, 'CKB_RECIPIENT_AMOUNT_BELOW_MINIMUM', 'The CKB amount is below the destination cell minimum.', {
          minimumAmountAtomic: minimum.toString(10)
        });
      }
      return 'ckb_address';
    }

    if (intent.rail !== 'fiber') {
      throw new ApiError(400, 'PAYMENT_RAIL_UNSUPPORTED', 'The Fiber connector does not support this payment rail.');
    }
    if (intent.destination.kind === 'endpoint') {
      if (intent.destination.value.length < 16 || /\s/.test(intent.destination.value)) {
        throw new ApiError(400, 'FIBER_ENDPOINT_INVALID', 'The Fiber endpoint is invalid.');
      }
      return 'fiber_endpoint';
    }
    if (intent.destination.kind !== 'invoice') {
      throw new ApiError(400, 'FIBER_DESTINATION_UNSUPPORTED', 'Fiber payments require an invoice or scoped endpoint.');
    }
    return 'fiber_invoice';
  }

  async validateDestination(intent: PaymentIntent): Promise<void> {
    if (this.validateIntentShape(intent) !== 'fiber_invoice') return;
    try {
      await this.adapter.preparePayment(connectorContext(intent));
    } catch (error) {
      throw sanitizedConnectorError(error, 'FIBER_INVOICE_PARSE_FAILED', 'Fiber invoice validation failed.');
    }
  }

  async quote(intent: PaymentIntent): Promise<PaymentQuote> {
    const destinationShape = this.validateIntentShape(intent);
    let paymentRequestHash: string | undefined;
    let providerCorrelationId: string | undefined;
    let invoiceAmountAtomic: string | undefined;
    let invoiceCurrency: string | undefined;
    let expiresAt = new Date(Date.now() + 60_000).toISOString();
    const zero = moneyValue(intent.money.assetId, asAtomicAmount('0'));
    if (destinationShape === 'fiber_invoice') {
      try {
        const prepared = await this.adapter.preparePayment(connectorContext(intent));
        paymentRequestHash = prepared.paymentRequestHash;
        providerCorrelationId = prepared.providerCorrelationId;
        invoiceAmountAtomic = prepared.invoice?.amountMinor == null ? undefined : prepared.invoice.amountMinor.toString(10);
        invoiceCurrency = prepared.invoice?.currency;
        if (prepared.invoice?.expiresAtSeconds != null) {
          expiresAt = new Date(prepared.invoice.expiresAtSeconds * 1000).toISOString();
        }
      } catch (error) {
        throw sanitizedConnectorError(error, 'FIBER_INVOICE_PARSE_FAILED', 'Fiber invoice validation failed.');
      }
    }
    if (intent.rail === 'ckb_onchain' && intent.destination.kind === 'address') {
      const minimumAmountAtomic = minimalRecipientCapacityMinor(intent.destination.value).toString(10);
      return {
        quoteId: quoteId(intent),
        intentId: intent.intentId,
        connectorId: this.id,
        amount: intent.money,
        fee: zero,
        total: intent.money,
        expiresAt,
        metadata: { contractVersion: PAYMENT_CONTRACT_VERSION, minimumAmountAtomic }
      };
    }
    return {
      quoteId: quoteId(intent),
      intentId: intent.intentId,
      connectorId: this.id,
      amount: intent.money,
      fee: zero,
      total: intent.money,
      expiresAt,
      metadata: {
        contractVersion: PAYMENT_CONTRACT_VERSION,
        ...(paymentRequestHash ? { paymentRequestHash } : {}),
        ...(providerCorrelationId ? { providerCorrelationId } : {}),
        ...(invoiceAmountAtomic ? { invoiceAmountAtomic } : {}),
        ...(invoiceCurrency ? { invoiceCurrency } : {})
      }
    };
  }

  async execute(intent: PaymentIntent, quote: PaymentQuote, context?: ConnectorExecutionContext): Promise<PaymentResult> {
    if (
      quote.connectorId !== this.id
      || quote.quoteId !== quoteId(intent)
      || quote.intentId !== intent.intentId
      || quote.amount.assetId !== intent.money.assetId
      || quote.amount.amountAtomic !== intent.money.amountAtomic
      || quote.total.assetId !== intent.money.assetId
      || quote.total.amountAtomic !== intent.money.amountAtomic
    ) {
      throw new ApiError(409, 'PAYMENT_QUOTE_MISMATCH', 'The payment quote does not match this connector intent.');
    }
    if (!Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= Date.now()) {
      throw new ApiError(410, 'PAYMENT_QUOTE_EXPIRED', 'The payment quote has expired.');
    }
    try {
      if (intent.rail === 'ckb_onchain') {
        const result = await this.vaultPayout({
          ownerWalletId: context?.ownerWalletId ?? '',
          sessionId: context?.sessionId ?? intent.intentId,
          recipientAddress: intent.destination.value,
          amountMinor: atomicAmountToLegacySafeNumber(intent.money.amountAtomic),
          currency: 'CKB'
        });
        return {
          intentId: intent.intentId,
          status: 'succeeded',
          amount: intent.money,
          connectorId: this.id,
          connectorReference: result.proofId,
          proof: {
            kind: 'transaction',
            reference: result.proofId,
            network: result.network,
            observedAt: new Date().toISOString(),
            metadata: { provider: result.provider }
          },
          updatedAt: new Date().toISOString()
        };
      }

      const result = await this.adapter.executePayment(connectorContext(intent, context));
      return {
        intentId: intent.intentId,
        status: 'succeeded',
        amount: intent.money,
        connectorId: this.id,
        connectorReference: result.proofId,
        proof: {
          kind: 'payment_hash',
          reference: result.proofId,
          network: result.network,
          observedAt: new Date().toISOString(),
          metadata: {
            provider: result.provider,
            ...(result.paymentRequestHash ? { paymentRequestHash: result.paymentRequestHash } : {})
          }
        },
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      throw sanitizedConnectorError(error, 'PAYMENT_CONNECTOR_EXECUTION_FAILED', 'Payment connector execution failed.');
    }
  }

  async lookup(input: ConnectorLookupInput): Promise<PaymentResult> {
    if (input.rail !== 'fiber') {
      throw new ApiError(400, 'PAYMENT_LOOKUP_UNSUPPORTED', 'This connector capability does not support payment lookup.');
    }
    if (
      input.network.trim().toLowerCase() !== this.provider.network.trim().toLowerCase()
      || input.assetId !== CKB_ASSET_ID
    ) {
      throw new ApiError(400, 'PAYMENT_CAPABILITY_UNSUPPORTED', 'This connector does not support the lookup capability.');
    }
    try {
      const result = await this.adapter.reconcilePayment(input.reference);
      const status = result.status === 'Success'
        ? 'succeeded'
        : result.status === 'Failed'
          ? 'failed'
          : 'pending';
      return {
        intentId: input.reference,
        status,
        amount: moneyValue(input.assetId, asAtomicAmount('0')),
        connectorId: this.id,
        connectorReference: result.paymentHash,
        proof: result.status === 'Success' ? {
          kind: 'payment_hash',
          reference: result.paymentHash,
          network: result.network,
          observedAt: new Date().toISOString(),
          metadata: { provider: result.provider }
        } : undefined,
        failureCode: result.status === 'Failed' ? 'FIBER_PAYMENT_FAILED' : undefined,
        failureMessage: result.status === 'Failed' ? 'Fiber payment failed.' : undefined,
        updatedAt: new Date().toISOString()
      };
    } catch (error) {
      throw sanitizedConnectorError(error, 'PAYMENT_CONNECTOR_LOOKUP_FAILED', 'Payment connector lookup failed.');
    }
  }

  getReadiness() {
    return getFiberNodeReadiness();
  }
}

export const fiberConnector = new FiberConnector();
