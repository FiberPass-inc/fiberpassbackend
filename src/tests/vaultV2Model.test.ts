import assert from 'node:assert/strict';
import {
  validateVaultV2Transition,
  type VaultV2Policy,
  type VaultV2State,
  type VaultV2Transition
} from '../domain/vaultV2.js';

const h = (byte: string) => '0x' + byte.repeat(64);
const policy: VaultV2Policy = {
  policyHash: h('a'),
  passIdHash: h('1'),
  ownerLockHash: h('2'),
  operatorLockHash: h('3'),
  recipientLockHash: h('4'),
  asset: { kind: 'native_ckb' },
  totalCapAtomic: '1000',
  perPaymentCapAtomic: '100',
  cadenceSeconds: 60,
  occurrenceLimit: 5,
  expirySeconds: 2000,
  feeCeilingShannons: '10'
};
const before: VaultV2State = {
  policyHash: policy.policyHash,
  remainingAtomic: '1000',
  occurrenceCount: 0,
  nextValidAfterSeconds: 1000,
  nonce: 7,
  status: 'active'
};
const payout: VaultV2Transition = {
  action: 'operator_payout',
  authLockHashes: [policy.operatorLockHash],
  inputPassIdHashes: [policy.passIdHash, policy.passIdHash],
  inputVaultAssetAtomic: '1000',
  outputVaultAssetAtomic: '895',
  recipientLockHash: policy.recipientLockHash,
  recipientAssetAtomic: '100',
  ownerNetAssetAtomic: '0',
  topUpAtomic: '0',
  feeShannons: '5',
  stateCapacityDeltaShannons: '0',
  verifiedTimeSeconds: 1100,
  outputState: {
    policyHash: policy.policyHash,
    remainingAtomic: '895',
    occurrenceCount: 1,
    nextValidAfterSeconds: 1160,
    nonce: 8,
    status: 'active'
  }
};

assert.deepEqual(validateVaultV2Transition(policy, before, payout), payout.outputState);

const invalidPayouts: Array<[string, Partial<VaultV2Transition>]> = [
  ['OPERATOR_AUTH_REQUIRED', { authLockHashes: [] }],
  ['PASS_CELL_MIXING', { inputPassIdHashes: [policy.passIdHash, h('9')] }],
  ['RECIPIENT_MISMATCH', { recipientLockHash: h('8') }],
  ['PAYMENT_CAP_EXCEEDED', {
    recipientAssetAtomic: '101',
    outputVaultAssetAtomic: '894',
    outputState: { ...payout.outputState!, remainingAtomic: '894' }
  }],
  ['FEE_CEILING_EXCEEDED', {
    feeShannons: '11',
    outputVaultAssetAtomic: '889',
    outputState: { ...payout.outputState!, remainingAtomic: '889' }
  }],
  ['ASSET_CONSERVATION_FAILED', { outputVaultAssetAtomic: '896' }],
  ['STATE_REMAINING_MISMATCH', {
    outputState: { ...payout.outputState!, remainingAtomic: '896' }
  }],
  ['NONCE_INVALID', {
    outputState: { ...payout.outputState!, nonce: 7 }
  }],
  ['CADENCE_NOT_REACHED', { verifiedTimeSeconds: 999 }],
  ['VAULT_EXPIRED', { verifiedTimeSeconds: 2000 }],
  ['TIME_EVIDENCE_REQUIRED', { verifiedTimeSeconds: undefined }],
  ['OCCURRENCE_COUNT_INVALID', {
    outputState: { ...payout.outputState!, occurrenceCount: 2 }
  }],
  ['NEXT_CADENCE_INVALID', {
    outputState: { ...payout.outputState!, nextValidAfterSeconds: 1161 }
  }]
];
for (const [code, mutation] of invalidPayouts) {
  assert.throws(
    () => validateVaultV2Transition(policy, before, { ...payout, ...mutation }),
    (error: unknown) => (error as { code?: string }).code === code,
    code
  );
}

const revokedState: VaultV2State = { ...before, status: 'revoked' };
assert.throws(
  () => validateVaultV2Transition(policy, revokedState, payout),
  (error: unknown) => (error as { code?: string }).code === 'VAULT_REVOKED'
);

const revoke: VaultV2Transition = {
  ...payout,
  action: 'owner_revoke',
  authLockHashes: [policy.ownerLockHash],
  outputVaultAssetAtomic: '1000',
  recipientLockHash: undefined,
  recipientAssetAtomic: '0',
  feeShannons: '0',
  verifiedTimeSeconds: undefined,
  outputState: {
    ...before,
    nonce: before.nonce + 1,
    status: 'revoked'
  }
};
assert.equal(validateVaultV2Transition(policy, before, revoke)?.status, 'revoked');
assert.throws(
  () => validateVaultV2Transition(policy, before, {
    ...revoke,
    outputVaultAssetAtomic: '999',
    outputState: { ...revoke.outputState!, remainingAtomic: '999' }
  }),
  (error: unknown) => (error as { code?: string }).code === 'ASSET_CONSERVATION_FAILED'
);

const reclaim: VaultV2Transition = {
  ...revoke,
  action: 'owner_reclaim',
  outputVaultAssetAtomic: '0',
  recipientLockHash: policy.ownerLockHash,
  ownerNetAssetAtomic: '994',
  feeShannons: '6',
  outputState: undefined
};
assert.equal(validateVaultV2Transition(policy, revokedState, reclaim), undefined);
assert.throws(
  () => validateVaultV2Transition(policy, revokedState, { ...reclaim, recipientLockHash: h('8') }),
  (error: unknown) => (error as { code?: string }).code === 'OWNER_RECIPIENT_MISMATCH'
);

const target = h('5');
const migrate: VaultV2Transition = {
  ...reclaim,
  action: 'owner_migrate',
  recipientLockHash: target,
  migrationTargetLockHash: target
};
assert.equal(validateVaultV2Transition(policy, before, migrate), undefined);
assert.throws(
  () => validateVaultV2Transition(policy, before, { ...migrate, recipientLockHash: h('6') }),
  (error: unknown) => (error as { code?: string }).code === 'MIGRATION_TARGET_MISMATCH'
);

const topUp: VaultV2Transition = {
  ...revoke,
  action: 'owner_top_up',
  inputVaultAssetAtomic: '800',
  outputVaultAssetAtomic: '1000',
  topUpAtomic: '200',
  outputState: {
    ...before,
    remainingAtomic: '1000',
    nonce: before.nonce + 1
  }
};
const beforeTopUp = { ...before, remainingAtomic: '800' };
assert.equal(validateVaultV2Transition(policy, beforeTopUp, topUp)?.remainingAtomic, '1000');
assert.throws(
  () => validateVaultV2Transition(policy, beforeTopUp, {
    ...topUp,
    outputVaultAssetAtomic: '1001',
    topUpAtomic: '201',
    outputState: { ...topUp.outputState!, remainingAtomic: '1001' }
  }),
  (error: unknown) => (error as { code?: string }).code === 'TOTAL_CAP_EXCEEDED'
);

const udtTypeHash = h('6');
const udtPolicy: VaultV2Policy = {
  ...policy,
  asset: { kind: 'udt', typeHash: udtTypeHash },
  totalCapAtomic: '500',
  perPaymentCapAtomic: '50'
};
const udtBefore = { ...before, policyHash: udtPolicy.policyHash, remainingAtomic: '500' };
const udtPayout: VaultV2Transition = {
  ...payout,
  observedAssetTypeHash: udtTypeHash,
  inputVaultAssetAtomic: '500',
  outputVaultAssetAtomic: '450',
  recipientAssetAtomic: '50',
  feeShannons: '5',
  outputState: {
    ...payout.outputState!,
    remainingAtomic: '450'
  }
};
assert.equal(validateVaultV2Transition(udtPolicy, udtBefore, udtPayout)?.remainingAtomic, '450');
assert.throws(
  () => validateVaultV2Transition(udtPolicy, udtBefore, {
    ...udtPayout,
    observedAssetTypeHash: h('7')
  }),
  (error: unknown) => (error as { code?: string }).code === 'ASSET_TYPE_MISMATCH'
);
assert.throws(
  () => validateVaultV2Transition(udtPolicy, udtBefore, {
    ...udtPayout,
    stateCapacityDeltaShannons: '1'
  }),
  (error: unknown) => (error as { code?: string }).code === 'UDT_STATE_CAPACITY_CHANGED'
);

const exhaustedPolicy = { ...policy, occurrenceLimit: 1 };
const exhaustedState = { ...before, occurrenceCount: 1 };
assert.throws(
  () => validateVaultV2Transition(exhaustedPolicy, exhaustedState, {
    ...payout,
    outputState: { ...payout.outputState!, occurrenceCount: 2 }
  }),
  (error: unknown) => (error as { code?: string }).code === 'OCCURRENCE_LIMIT_REACHED'
);
