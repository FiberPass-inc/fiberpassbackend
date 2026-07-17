import { asAtomicAmount, atomicAmountFromBigInt, parseAtomicAmount } from '../lib/money.js';

export const VAULT_V2_ACTIONS = [
  'operator_payout',
  'owner_top_up',
  'owner_revoke',
  'owner_reclaim',
  'owner_migrate'
] as const;
export type VaultV2Action = (typeof VAULT_V2_ACTIONS)[number];

export type VaultV2Asset =
  | { kind: 'native_ckb' }
  | { kind: 'udt'; typeHash: string };

export interface VaultV2Policy {
  policyHash: string;
  passIdHash: string;
  ownerLockHash: string;
  operatorLockHash: string;
  recipientLockHash: string;
  asset: VaultV2Asset;
  totalCapAtomic: string;
  perPaymentCapAtomic: string;
  cadenceSeconds: number;
  occurrenceLimit: number;
  expirySeconds?: number;
  feeCeilingShannons: string;
}

export interface VaultV2State {
  policyHash: string;
  remainingAtomic: string;
  occurrenceCount: number;
  nextValidAfterSeconds: number;
  nonce: number;
  status: 'active' | 'revoked';
}

export interface VaultV2Transition {
  action: VaultV2Action;
  authLockHashes: string[];
  inputPassIdHashes: string[];
  observedAssetTypeHash?: string;
  inputVaultAssetAtomic: string;
  outputVaultAssetAtomic: string;
  recipientLockHash?: string;
  recipientAssetAtomic: string;
  ownerNetAssetAtomic: string;
  topUpAtomic: string;
  feeShannons: string;
  stateCapacityDeltaShannons: string;
  verifiedTimeSeconds?: number;
  outputState?: VaultV2State;
  migrationTargetLockHash?: string;
}

export class VaultV2ModelError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function fail(code: string, message: string): never {
  throw new VaultV2ModelError(code, message);
}

function hash(value: string, field: string): string {
  if (!/^0x[0-9a-f]{64}$/.test(value)) fail('INVALID_HASH', field + ' must be a canonical 32-byte lowercase hash.');
  return value;
}

function amount(value: string, field: string): bigint {
  try {
    return parseAtomicAmount(asAtomicAmount(value));
  } catch {
    return fail('INVALID_AMOUNT', field + ' must be a canonical non-negative atomic amount.');
  }
}

function integer(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) fail('INVALID_INTEGER', field + ' must be a non-negative safe integer.');
  return value;
}

function validatePolicy(policy: VaultV2Policy): void {
  hash(policy.policyHash, 'policyHash');
  hash(policy.passIdHash, 'passIdHash');
  hash(policy.ownerLockHash, 'ownerLockHash');
  hash(policy.operatorLockHash, 'operatorLockHash');
  hash(policy.recipientLockHash, 'recipientLockHash');
  if (policy.asset.kind === 'udt') hash(policy.asset.typeHash, 'asset.typeHash');
  const total = amount(policy.totalCapAtomic, 'totalCapAtomic');
  const perPayment = amount(policy.perPaymentCapAtomic, 'perPaymentCapAtomic');
  if (total <= 0n || perPayment <= 0n || perPayment > total) {
    fail('INVALID_CAP', 'Vault caps must be positive and per-payment cap cannot exceed total cap.');
  }
  integer(policy.cadenceSeconds, 'cadenceSeconds');
  if (integer(policy.occurrenceLimit, 'occurrenceLimit') < 1) fail('INVALID_OCCURRENCE_LIMIT', 'Occurrence limit must be positive.');
  if (policy.expirySeconds != null) integer(policy.expirySeconds, 'expirySeconds');
  amount(policy.feeCeilingShannons, 'feeCeilingShannons');
}

function validateState(policy: VaultV2Policy, state: VaultV2State): void {
  if (state.policyHash !== policy.policyHash) fail('POLICY_HASH_MISMATCH', 'State does not commit to the immutable policy.');
  if (amount(state.remainingAtomic, 'state.remainingAtomic') > amount(policy.totalCapAtomic, 'totalCapAtomic')) {
    fail('TOTAL_CAP_EXCEEDED', 'State remaining amount exceeds the committed total cap.');
  }
  integer(state.occurrenceCount, 'state.occurrenceCount');
  integer(state.nextValidAfterSeconds, 'state.nextValidAfterSeconds');
  integer(state.nonce, 'state.nonce');
}

function requireAuth(transition: VaultV2Transition, expected: string, code: string): void {
  if (!transition.authLockHashes.includes(expected)) fail(code, 'Required authorization input is missing.');
}

function requireOutputState(
  policy: VaultV2Policy,
  before: VaultV2State,
  transition: VaultV2Transition
): VaultV2State {
  const output = transition.outputState;
  if (!output) fail('OUTPUT_STATE_REQUIRED', 'This action must create exactly one v2 state output.');
  validateState(policy, output);
  if (output.policyHash !== before.policyHash) fail('POLICY_MUTATION', 'Policy hash cannot change within a v2 state transition.');
  if (output.nonce !== before.nonce + 1) fail('NONCE_INVALID', 'Output nonce must increase by exactly one.');
  return output;
}

function requireZero(value: bigint, code: string, message: string): void {
  if (value !== 0n) fail(code, message);
}

function validateAsset(policy: VaultV2Policy, transition: VaultV2Transition): void {
  if (policy.asset.kind === 'native_ckb') {
    if (transition.observedAssetTypeHash != null) fail('UNEXPECTED_TYPE_SCRIPT', 'Native CKB vault cells cannot carry a UDT type script.');
    return;
  }
  if (transition.observedAssetTypeHash !== policy.asset.typeHash) {
    fail('ASSET_TYPE_MISMATCH', 'UDT type script hash does not match the immutable asset commitment.');
  }
  requireZero(
    amount(transition.stateCapacityDeltaShannons, 'stateCapacityDeltaShannons'),
    'UDT_STATE_CAPACITY_CHANGED',
    'UDT payout cannot drain or credit the state-cell capacity.'
  );
}

function validateCommon(policy: VaultV2Policy, before: VaultV2State, transition: VaultV2Transition): {
  input: bigint;
  output: bigint;
  recipient: bigint;
  ownerNet: bigint;
  topUp: bigint;
  fee: bigint;
} {
  validatePolicy(policy);
  validateState(policy, before);
  if (
    transition.inputPassIdHashes.length === 0
    || transition.inputPassIdHashes.some((passId) => passId !== policy.passIdHash)
  ) {
    fail('PASS_CELL_MIXING', 'A transaction may consume cells from exactly one committed pass.');
  }
  validateAsset(policy, transition);
  const values = {
    input: amount(transition.inputVaultAssetAtomic, 'inputVaultAssetAtomic'),
    output: amount(transition.outputVaultAssetAtomic, 'outputVaultAssetAtomic'),
    recipient: amount(transition.recipientAssetAtomic, 'recipientAssetAtomic'),
    ownerNet: amount(transition.ownerNetAssetAtomic, 'ownerNetAssetAtomic'),
    topUp: amount(transition.topUpAtomic, 'topUpAtomic'),
    fee: amount(transition.feeShannons, 'feeShannons')
  };
  if (values.input !== amount(before.remainingAtomic, 'state.remainingAtomic')) {
    fail('INPUT_STATE_ASSET_MISMATCH', 'Input vault assets must equal state remaining amount.');
  }
  if (values.fee > amount(policy.feeCeilingShannons, 'feeCeilingShannons')) {
    fail('FEE_CEILING_EXCEEDED', 'Transaction fee exceeds the immutable ceiling.');
  }
  return values;
}

function requireVerifiedTime(policy: VaultV2Policy, before: VaultV2State, transition: VaultV2Transition): number {
  const now = transition.verifiedTimeSeconds;
  if (now == null) fail('TIME_EVIDENCE_REQUIRED', 'Operator payout requires approved non-replayable on-chain time evidence.');
  integer(now, 'verifiedTimeSeconds');
  if (now < before.nextValidAfterSeconds) fail('CADENCE_NOT_REACHED', 'Operator payout is earlier than the next committed cadence time.');
  if (policy.expirySeconds != null && now >= policy.expirySeconds) fail('VAULT_EXPIRED', 'Operator payout is disabled at or after expiry.');
  return now;
}

function validateOperatorPayout(
  policy: VaultV2Policy,
  before: VaultV2State,
  transition: VaultV2Transition,
  values: ReturnType<typeof validateCommon>
): VaultV2State {
  requireAuth(transition, policy.operatorLockHash, 'OPERATOR_AUTH_REQUIRED');
  if (before.status !== 'active') fail('VAULT_REVOKED', 'Operator payout is disabled after owner revocation.');
  const now = requireVerifiedTime(policy, before, transition);
  if (values.recipient <= 0n || values.recipient > amount(policy.perPaymentCapAtomic, 'perPaymentCapAtomic')) {
    fail('PAYMENT_CAP_EXCEEDED', 'Recipient amount must be positive and no greater than the per-payment cap.');
  }
  if (values.recipient > values.input) fail('INSUFFICIENT_REMAINING', 'Payout exceeds the remaining vault amount.');
  if (transition.recipientLockHash !== policy.recipientLockHash) {
    fail('RECIPIENT_MISMATCH', 'Payout recipient does not match the immutable lock commitment.');
  }
  requireZero(values.ownerNet, 'OWNER_OUTPUT_FORBIDDEN', 'Operator payout cannot create an owner recovery output.');
  requireZero(values.topUp, 'TOP_UP_FORBIDDEN', 'Operator payout cannot increase vault funds.');
  if (before.occurrenceCount >= policy.occurrenceLimit) fail('OCCURRENCE_LIMIT_REACHED', 'Occurrence limit is exhausted.');
  const feeFromVault = policy.asset.kind === 'native_ckb' ? values.fee : 0n;
  const expectedRemaining = values.input - values.recipient - feeFromVault;
  if (expectedRemaining < 0n || values.output !== expectedRemaining) {
    fail('ASSET_CONSERVATION_FAILED', 'Vault change must equal input minus exact recipient amount and allowed native fee.');
  }
  const output = requireOutputState(policy, before, transition);
  if (amount(output.remainingAtomic, 'output.remainingAtomic') !== expectedRemaining) {
    fail('STATE_REMAINING_MISMATCH', 'Output state remaining amount does not match conserved vault change.');
  }
  if (output.occurrenceCount !== before.occurrenceCount + 1) {
    fail('OCCURRENCE_COUNT_INVALID', 'Successful payout must increment occurrence count by exactly one.');
  }
  if (output.status !== 'active') fail('STATUS_INVALID', 'Operator payout must preserve active status.');
  const expectedNext = Math.max(before.nextValidAfterSeconds, now) + policy.cadenceSeconds;
  if (output.nextValidAfterSeconds !== expectedNext) {
    fail('NEXT_CADENCE_INVALID', 'Output next-valid time does not match the committed cadence.');
  }
  return output;
}

function validateOwnerTopUp(
  policy: VaultV2Policy,
  before: VaultV2State,
  transition: VaultV2Transition,
  values: ReturnType<typeof validateCommon>
): VaultV2State {
  requireAuth(transition, policy.ownerLockHash, 'OWNER_AUTH_REQUIRED');
  if (before.status !== 'active') fail('VAULT_REVOKED', 'Revoked vault cannot be topped up.');
  if (values.topUp <= 0n) fail('TOP_UP_REQUIRED', 'Owner top-up amount must be positive.');
  requireZero(values.recipient, 'RECIPIENT_OUTPUT_FORBIDDEN', 'Top-up cannot create a payout.');
  requireZero(values.ownerNet, 'OWNER_OUTPUT_FORBIDDEN', 'Top-up cannot reclaim funds.');
  requireZero(values.fee, 'EXTERNAL_FEE_REQUIRED', 'Top-up transaction fee must be funded outside the v2 group.');
  const expected = values.input + values.topUp;
  if (expected > amount(policy.totalCapAtomic, 'totalCapAtomic') || values.output !== expected) {
    fail('TOTAL_CAP_EXCEEDED', 'Top-up output must conserve assets and remain within total cap.');
  }
  const output = requireOutputState(policy, before, transition);
  if (
    amount(output.remainingAtomic, 'output.remainingAtomic') !== expected
    || output.occurrenceCount !== before.occurrenceCount
    || output.nextValidAfterSeconds !== before.nextValidAfterSeconds
    || output.status !== 'active'
  ) {
    fail('TOP_UP_STATE_INVALID', 'Top-up may change only remaining amount and nonce.');
  }
  return output;
}

function validateOwnerRevoke(
  policy: VaultV2Policy,
  before: VaultV2State,
  transition: VaultV2Transition,
  values: ReturnType<typeof validateCommon>
): VaultV2State {
  requireAuth(transition, policy.ownerLockHash, 'OWNER_AUTH_REQUIRED');
  requireZero(values.recipient, 'RECIPIENT_OUTPUT_FORBIDDEN', 'Revoke cannot create a payout.');
  requireZero(values.ownerNet, 'OWNER_OUTPUT_FORBIDDEN', 'Revoke does not reclaim funds.');
  requireZero(values.topUp, 'TOP_UP_FORBIDDEN', 'Revoke cannot top up funds.');
  requireZero(values.fee, 'EXTERNAL_FEE_REQUIRED', 'Revoke fee must be funded outside the v2 group.');
  if (values.output !== values.input) fail('ASSET_CONSERVATION_FAILED', 'Revoke must preserve all vault assets.');
  const output = requireOutputState(policy, before, transition);
  if (
    output.remainingAtomic !== before.remainingAtomic
    || output.occurrenceCount !== before.occurrenceCount
    || output.nextValidAfterSeconds !== before.nextValidAfterSeconds
    || output.status !== 'revoked'
  ) {
    fail('REVOKE_STATE_INVALID', 'Revoke may change only status and nonce.');
  }
  return output;
}

function validateOwnerExit(
  policy: VaultV2Policy,
  transition: VaultV2Transition,
  values: ReturnType<typeof validateCommon>,
  migration: boolean
): undefined {
  requireAuth(transition, policy.ownerLockHash, 'OWNER_AUTH_REQUIRED');
  if (transition.outputState) fail('STATE_OUTPUT_FORBIDDEN', 'Full owner exit cannot leave a v2 state cell.');
  if (values.output !== 0n) fail('VAULT_CHANGE_FORBIDDEN', 'Full owner exit cannot leave v2 asset change.');
  requireZero(values.recipient, 'RECIPIENT_OUTPUT_FORBIDDEN', 'Owner exit cannot pay the committed service recipient.');
  requireZero(values.topUp, 'TOP_UP_FORBIDDEN', 'Owner exit cannot top up funds.');
  const expected = values.input - (policy.asset.kind === 'native_ckb' ? values.fee : 0n);
  if (values.ownerNet !== expected) fail('OWNER_CONSERVATION_FAILED', 'Owner net output must receive every remaining asset minus an allowed native fee.');
  if (migration) {
    if (!transition.migrationTargetLockHash) fail('MIGRATION_TARGET_REQUIRED', 'Owner migration requires a target lock hash.');
    hash(transition.migrationTargetLockHash, 'migrationTargetLockHash');
    if (transition.recipientLockHash !== transition.migrationTargetLockHash) {
      fail('MIGRATION_TARGET_MISMATCH', 'Migrated assets must go only to the owner-approved target lock.');
    }
  } else if (transition.recipientLockHash !== policy.ownerLockHash) {
    fail('OWNER_RECIPIENT_MISMATCH', 'Reclaim output must use the committed owner lock.');
  }
  return undefined;
}

export function validateVaultV2Transition(
  policy: VaultV2Policy,
  before: VaultV2State,
  transition: VaultV2Transition
): VaultV2State | undefined {
  const values = validateCommon(policy, before, transition);
  switch (transition.action) {
    case 'operator_payout':
      return validateOperatorPayout(policy, before, transition, values);
    case 'owner_top_up':
      return validateOwnerTopUp(policy, before, transition, values);
    case 'owner_revoke':
      return validateOwnerRevoke(policy, before, transition, values);
    case 'owner_reclaim':
      return validateOwnerExit(policy, transition, values, false);
    case 'owner_migrate':
      return validateOwnerExit(policy, transition, values, true);
  }
}

export function vaultV2Amount(value: bigint): string {
  return atomicAmountFromBigInt(value);
}
