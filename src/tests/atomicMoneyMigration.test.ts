import assert from 'node:assert/strict';
import { buildAtomicMoneyPatch } from '../migrations/atomicMoney.js';

const productionShapedSession = {
  publicId: 'fp_pass_existing_001',
  ownerWalletId: 'wallet-existing-001',
  currency: 'CKB',
  limit: 1240.5,
  limitMinor: 124_050_000_000,
  spent: 40.5,
  spentMinor: 4_050_000_000,
  reservedMinor: 200_000_000,
  platformFeeEstimateMinor: 620_250_000,
  networkFeeEstimateMinor: 100_000,
  logs: [
    { id: 'log-1', type: 'Session funded', amount: 1240.5, amountMinor: 124_050_000_000 }
  ],
  recipientWallets: [
    {
      name: 'Merchant',
      address: 'ckt1productionfixture',
      amount: 1.25,
      amountMinor: 125_000_000,
      fiberLiquidityBridgeAmountMinor: 130_000_000,
      fiberChannelOpenAmountMinor: 125_000_000
    }
  ]
};

const patch = buildAtomicMoneyPatch('session', productionShapedSession);
assert.equal(patch.assetId, 'ckb:ckb');
assert.equal(patch.moneyContractVersion, 2);
assert.equal(patch.limitAtomic, '124050000000');
assert.equal(patch.spentAtomic, '4050000000');
assert.equal(patch.reservedAtomic, '200000000');
assert.equal(patch.platformFeeEstimateAtomic, '620250000');
assert.equal(patch.networkFeeEstimateAtomic, '100000');
assert.equal((patch.logs as Record<string, unknown>[])[0].amountAtomic, '124050000000');
assert.equal((patch.recipientWallets as Record<string, unknown>[])[0].amountAtomic, '125000000');
assert.equal((patch.recipientWallets as Record<string, unknown>[])[0].fiberLiquidityBridgeAmountAtomic, '130000000');
assert.equal((patch.recipientWallets as Record<string, unknown>[])[0].fiberChannelOpenAmountAtomic, '125000000');

assert.deepEqual(buildAtomicMoneyPatch('chargeAttempt', {
  currency: 'CKB',
  amountMinor: 100_000_000,
  resultingSpentMinor: 300_000_000,
  remainingBalanceMinor: 700_000_000
}), {
  assetId: 'ckb:ckb',
  moneyContractVersion: 2,
  amountAtomic: '100000000',
  resultingSpentAtomic: '300000000',
  remainingBalanceAtomic: '700000000'
});

assert.throws(() => buildAtomicMoneyPatch('wallet', {
  currency: 'CKB',
  balanceMinor: Number.MAX_SAFE_INTEGER + 1
}), /safe integer/);
assert.throws(() => buildAtomicMoneyPatch('invoice', {
  currency: 'CKB',
  amountMinor: 100,
  amountAtomic: '101'
}), /conflicts/);
