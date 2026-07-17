import type {
  AssetId,
  PaymentDestinationKind,
  PaymentIntent,
  PaymentQuote,
  PaymentRail,
  PaymentResult
} from '../domain/payment.js';
import type { ConnectorFundingCapability } from '../domain/funding.js';

export interface ConnectorCapability {
  connectorId: string;
  rail: PaymentRail;
  network: string;
  assetId: AssetId;
  destinationKinds: readonly PaymentDestinationKind[];
  supportsLookup: boolean;
  supportsRefund: boolean;
  funding: readonly ConnectorFundingCapability[];
}

export interface ConnectorExecutionContext {
  sessionId?: string;
  ownerWalletId?: string;
  networkSessionId?: string;
  appAddress?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface ConnectorLookupInput {
  rail: PaymentRail;
  network: string;
  assetId: AssetId;
  reference: string;
  ownerWalletId?: string;
  connectionId?: string;
}

export interface ConnectorRefundInput {
  original: PaymentResult;
  reason: string;
  idempotencyKey: string;
}

export interface PaymentConnector {
  readonly id: string;
  capabilities(): readonly ConnectorCapability[];
  validateDestination(intent: PaymentIntent): Promise<void>;
  quote(intent: PaymentIntent): Promise<PaymentQuote>;
  execute(intent: PaymentIntent, quote: PaymentQuote, context?: ConnectorExecutionContext): Promise<PaymentResult>;
  lookup(input: ConnectorLookupInput): Promise<PaymentResult>;
  refund?(input: ConnectorRefundInput): Promise<PaymentResult>;
}
