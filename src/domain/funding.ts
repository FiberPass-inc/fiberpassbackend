export const FUNDING_MODES = ['connected_wallet', 'secured_autopay'] as const;
export type FundingMode = (typeof FUNDING_MODES)[number];

export const FUNDING_SOURCE_KINDS = ['external_wallet', 'network_contract', 'legacy_operator_vault'] as const;
export type FundingSourceKind = (typeof FUNDING_SOURCE_KINDS)[number];

export const FUNDING_GUARANTEES = [
  'authorization_only',
  'balance_observed',
  'network_locked',
  'network_locked_operator_controlled'
] as const;
export type FundingGuarantee = (typeof FUNDING_GUARANTEES)[number];

export const FUNDING_SOURCE_STATES = ['unverified', 'available', 'fully_allocated', 'insufficient', 'stale', 'failed', 'revoked'] as const;
export type FundingSourceState = (typeof FUNDING_SOURCE_STATES)[number];

export const FUNDING_ALLOCATION_STATES = ['active', 'released', 'exhausted'] as const;
export type FundingAllocationState = (typeof FUNDING_ALLOCATION_STATES)[number];

export const FUNDING_RISK_LABELS = ['none', 'unaudited_operator_contract', 'legacy_operator_vault'] as const;
export type FundingRiskLabel = (typeof FUNDING_RISK_LABELS)[number];

export interface FundingAmounts {
  availableMinor: number;
  authorizedMinor: number;
  lockedMinor: number;
  reservedMinor: number;
  spentMinor: number;
  releasedMinor: number;
  reclaimableMinor: number;
}

function checkedMinor(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(field + ' must be a non-negative safe integer.');
  return value;
}

export function securedReclaimableMinor(input: Pick<FundingAmounts, 'lockedMinor' | 'reservedMinor'>): number {
  const locked = checkedMinor(input.lockedMinor, 'lockedMinor');
  const reserved = checkedMinor(input.reservedMinor, 'reservedMinor');
  if (reserved > locked) throw new Error('Secured funding reservations cannot exceed network-locked funds.');
  return locked - reserved;
}

export function allocationRemainingMinor(input: { authorizedMinor: number; spentMinor: number; releasedMinor: number }): number {
  const authorized = checkedMinor(input.authorizedMinor, 'authorizedMinor');
  const spent = checkedMinor(input.spentMinor, 'spentMinor');
  const released = checkedMinor(input.releasedMinor, 'releasedMinor');
  if (spent + released > authorized) throw new Error('Funding allocation spent plus released cannot exceed its authorization.');
  return authorized - spent - released;
}

export function fundingSourceState(input: {
  mode: FundingMode;
  availableMinor: number;
  authorizedMinor: number;
  lockedMinor: number;
  reservedMinor: number;
  hasNetworkProof: boolean;
  observedAt?: Date | null;
  staleAt?: Date | null;
  now?: Date;
}): FundingSourceState {
  const now = input.now ?? new Date();
  if (input.staleAt && input.staleAt.getTime() <= now.getTime()) return 'stale';
  if (input.mode === 'secured_autopay') {
    if (!input.hasNetworkProof) return 'unverified';
    const reclaimable = securedReclaimableMinor(input);
    return reclaimable === 0 ? 'fully_allocated' : 'available';
  }
  if (!input.observedAt) return 'unverified';
  const available = checkedMinor(input.availableMinor, 'availableMinor');
  const authorized = checkedMinor(input.authorizedMinor, 'authorizedMinor');
  return available > 0 && available >= authorized ? 'available' : 'insufficient';
}

export interface ConnectorFundingCapability {
  mode: FundingMode;
  guarantee: FundingGuarantee;
  requiresNetworkProof: boolean;
  supportsExecution: boolean;
  balanceSource: 'external_wallet' | 'network_contract' | 'connector_channel';
  failureStates: readonly string[];
}
