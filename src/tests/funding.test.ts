import assert from 'node:assert/strict';
import {
  allocationRemainingMinor,
  fundingSourceState,
  securedReclaimableMinor
} from '../domain/funding.js';
import { buildLegacyFundingMigrationSnapshot } from '../migrations/fundingSources.js';
import { FundingAllocationModel, FundingSourceModel } from '../models/fundingSource.model.js';

assert.equal(securedReclaimableMinor({ lockedMinor: 100, reservedMinor: 40 }), 60);
assert.throws(
  () => securedReclaimableMinor({ lockedMinor: 40, reservedMinor: 41 }),
  /cannot exceed/
);
assert.equal(allocationRemainingMinor({ authorizedMinor: 100, spentMinor: 30, releasedMinor: 20 }), 50);
assert.throws(
  () => allocationRemainingMinor({ authorizedMinor: 100, spentMinor: 80, releasedMinor: 21 }),
  /cannot exceed/
);
assert.equal(fundingSourceState({
  mode: 'secured_autopay',
  availableMinor: 100,
  authorizedMinor: 0,
  lockedMinor: 100,
  reservedMinor: 0,
  hasNetworkProof: false
}), 'unverified');
assert.equal(fundingSourceState({
  mode: 'secured_autopay',
  availableMinor: 100,
  authorizedMinor: 100,
  lockedMinor: 100,
  reservedMinor: 100,
  hasNetworkProof: true
}), 'fully_allocated');
assert.equal(fundingSourceState({
  mode: 'connected_wallet',
  availableMinor: 0,
  authorizedMinor: 0,
  lockedMinor: 0,
  reservedMinor: 0,
  hasNetworkProof: false,
  observedAt: new Date()
}), 'insufficient');
assert.equal(fundingSourceState({
  mode: 'connected_wallet',
  availableMinor: 99,
  authorizedMinor: 100,
  lockedMinor: 0,
  reservedMinor: 0,
  hasNetworkProof: false,
  observedAt: new Date()
}), 'insufficient');

const migrationNow = new Date('2026-07-17T12:00:00.000Z');
const unproved = buildLegacyFundingMigrationSnapshot({
  wallet: { walletId: 'legacy-wallet', balanceMinor: 500, currency: 'CKB' },
  sessions: [{
    publicId: 'legacy-pass',
    ownerWalletId: 'legacy-wallet',
    status: 'active',
    limitMinor: 400,
    spentMinor: 100,
    currency: 'CKB',
    createdAt: new Date('2026-07-01')
  }],
  funding: [],
  now: migrationNow
});
assert.equal(unproved.source.riskLabel, 'legacy_operator_vault');
assert.equal(unproved.source.lockedAtomic, '0');
assert.equal(unproved.source.authorizedAtomic, '300');
assert.equal(unproved.source.state, 'unverified');
assert.equal(unproved.allocations[0].sessionPatch.fundingExecutionReady, false);
assert.equal(unproved.allocations[0].sessionPatch.fundingFailureCode, 'SECURED_FUNDING_PROOF_REQUIRED');

const stale = buildLegacyFundingMigrationSnapshot({
  wallet: { walletId: 'proved-wallet', balanceMinor: 500, currency: 'CKB' },
  sessions: [{
    publicId: 'proved-pass',
    status: 'active',
    limitMinor: 400,
    spentMinor: 0,
    currency: 'CKB'
  }],
  funding: [{
    status: 'confirmed',
    amountMinor: 500,
    currency: 'CKB',
    proofId: '0xproof',
    confirmedAt: new Date('2026-07-16T12:00:00.000Z')
  }],
  now: migrationNow
});
assert.equal(stale.source.lockedAtomic, '500');
assert.equal(stale.source.state, 'stale');
assert.equal(stale.source.failureCode, 'SECURED_FUNDING_PROOF_STALE');

const securedWithoutProof = new FundingSourceModel({
  sourceId: 'source-unproved',
  ownerWalletId: 'wallet',
  mode: 'secured_autopay',
  sourceKind: 'network_contract',
  sourceReference: 'contract',
  rail: 'ckb_onchain',
  network: 'testnet',
  assetId: 'ckb:ckb',
  moneyContractVersion: 2,
  guarantee: 'network_locked',
  riskLabel: 'none',
  state: 'available',
  availableMinor: 1,
  availableAtomic: '1',
  authorizedMinor: 0,
  authorizedAtomic: '0',
  lockedMinor: 1,
  lockedAtomic: '1',
  reservedMinor: 0,
  reservedAtomic: '0',
  spentMinor: 0,
  spentAtomic: '0',
  releasedMinor: 0,
  releasedAtomic: '0',
  reclaimableMinor: 1,
  reclaimableAtomic: '1'
});
await assert.rejects(() => securedWithoutProof.validate(), /network proof/);
assert.ok(FundingSourceModel.schema.path('networkProofId'));
assert.ok(FundingAllocationModel.schema.indexes().some(([fields, options]) => fields.sessionId === 1 && options?.unique === true));
