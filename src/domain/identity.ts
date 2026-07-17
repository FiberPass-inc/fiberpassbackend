export const PRINCIPAL_PROOF_TYPES = ['wallet_signature', 'legacy_authenticated_wallet'] as const;
export type PrincipalProofType = (typeof PRINCIPAL_PROOF_TYPES)[number];

export const DESTINATION_KINDS = ['address', 'invoice', 'endpoint', 'bolt12_offer', 'lnurl', 'lightning_address'] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export const DESTINATION_RAILS = ['ckb_onchain', 'fiber', 'lightning', 'bitcoin_onchain'] as const;
export type DestinationRail = (typeof DESTINATION_RAILS)[number];

export const DESTINATION_STATUSES = ['active', 'replaced', 'revoked'] as const;
export type DestinationStatus = (typeof DESTINATION_STATUSES)[number];

export const DESTINATION_VERIFICATION_METHODS = ['claim_link', 'owner_configured', 'wallet_signature', 'legacy_import'] as const;
export type DestinationVerificationMethod = (typeof DESTINATION_VERIFICATION_METHODS)[number];

export const DESTINATION_VERIFICATION_SCOPES = ['delivery_instruction', 'wallet_control'] as const;
export type DestinationVerificationScope = (typeof DESTINATION_VERIFICATION_SCOPES)[number];

export const CONTACT_CHANNEL_TYPES = ['email', 'nostr'] as const;
export type ContactChannelType = (typeof CONTACT_CHANNEL_TYPES)[number];

export const NOTIFICATION_ENDPOINT_STATUSES = ['active', 'revoked', 'unsubscribed', 'deleted'] as const;
export type NotificationEndpointStatus = (typeof NOTIFICATION_ENDPOINT_STATUSES)[number];

export const CLAIM_STATUSES = ['pending', 'claimed', 'expired', 'revoked'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export interface WalletPrincipal {
  principalId: string;
  walletId: string;
  address: string;
  proofType: PrincipalProofType;
  verifiedAt: Date;
}

export interface Recipient {
  recipientId: string;
  ownerWalletId: string;
  name: string;
  sessionId?: string;
  sessionRecipientIndex?: number;
  automationRecipientId?: string;
}

export interface PaymentDestination {
  destinationId: string;
  recipientId: string;
  rail: DestinationRail;
  network: string;
  assetId: string;
  kind: DestinationKind;
  reusable: boolean;
  verificationMethod: DestinationVerificationMethod;
  verificationScope: DestinationVerificationScope;
  verifiedAt: Date;
}

export interface ClaimChannel {
  channelId: string;
  recipientId: string;
  type: ContactChannelType;
}

export interface NotificationEndpoint {
  endpointId: string;
  recipientId: string;
  type: ContactChannelType;
  purpose: 'receipt';
}

export function isReusableDestinationKind(kind: DestinationKind): boolean {
  return kind !== 'invoice';
}

export function paymentPurposeRepeats(paymentPurpose: string): boolean {
  return paymentPurpose === 'subscription' || paymentPurpose === 'recurring_release';
}
