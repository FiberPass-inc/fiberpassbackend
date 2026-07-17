import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { SessionModel } from '../models/session.model.js';
import { WalletFundingModel } from '../models/walletFunding.model.js';
import { WalletModel } from '../models/wallet.model.js';
import { FundingAllocationModel, FundingSourceModel } from '../models/fundingSource.model.js';

const uri = process.env.LIFECYCLE_TEST_MONGODB_URI;
if (!uri) {
  throw new Error('LIFECYCLE_TEST_MONGODB_URI is required for lifecycle integration tests.');
}

// Keep these tests fully ledger-local; vault derivation and chain calls have separate coverage.
process.env.FIBERPASS_VAULT_CODE_HASH = '';
process.env.FIBERPASS_OPERATOR_LOCK_HASH = '';

const { createSession, revokeSession, settleSession, topUpSession } = await import('../services/session.service.js');
const { applyConfirmedFunding } = await import('../services/walletFunding.service.js');

const dbName = 'fiberpass_session_lifecycle_' + randomUUID().replace(/-/g, '');
await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10_000 });

const walletAddress = 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl';

try {
  await Promise.all([
    SessionModel.syncIndexes(),
    WalletFundingModel.syncIndexes(),
    WalletModel.syncIndexes(),
    FundingAllocationModel.syncIndexes(),
    FundingSourceModel.syncIndexes()
  ]);

  const fundingWalletId = 'wallet-funding-atomic';
  await WalletModel.create({
    walletId: fundingWalletId,
    connected: true,
    address: walletAddress,
    balance: 0,
    balanceMinor: 0,
    currency: 'CKB'
  });
  const funding = await WalletFundingModel.create({
    fundingId: 'funding-atomic',
    walletId: fundingWalletId,
    walletAddress,
    amount: 1,
    amountMinor: 100_000_000,
    currency: 'CKB',
    network: 'testnet',
    depositMode: 'vault',
    depositAddress: walletAddress,
    memo: 'integration funding',
    status: 'pending'
  });
  const deposit = {
    txHash: '0x' + '11'.repeat(32),
    outputIndex: '0x0',
    outPoint: '0x' + '11'.repeat(32) + ':0x0',
    capacityShannons: 100_000_000,
    blockHash: '0x' + '22'.repeat(32),
    blockNumber: '0x1'
  };
  const fundingResults = await Promise.all(
    Array.from({ length: 20 }, () => applyConfirmedFunding({
      walletId: fundingWalletId,
      funding,
      deposit,
      proofId: deposit.txHash
    }))
  );
  assert.equal(fundingResults.filter(Boolean).length, 1);
  assert.equal((await WalletModel.findOne({ walletId: fundingWalletId }).lean())?.balanceMinor, 100_000_000);
  assert.equal((await WalletFundingModel.findOne({ fundingId: 'funding-atomic' }).lean())?.status, 'confirmed');

  const lifecycleWalletId = 'wallet-lifecycle-atomic';
  await WalletModel.create({
    walletId: lifecycleWalletId,
    connected: true,
    address: walletAddress,
    balance: 5,
    balanceMinor: 500_000_000,
    currency: 'CKB'
  });
  const createInput = {
    name: 'Atomic lifecycle pass',
    serviceAddress: walletAddress,
    limit: 1,
    currency: 'CKB',
    duration: 'integration',
    expiryTime: 'No expiry',
    autoMicroCharges: true,
    singleUse: false,
    iconType: 'rpc' as const
  };

  await assert.rejects(() => createSession({ ...createInput, iconType: 'invalid' as 'rpc' }, lifecycleWalletId));
  assert.equal(await SessionModel.countDocuments({ ownerWalletId: lifecycleWalletId }), 0);
  assert.equal((await WalletModel.findOne({ walletId: lifecycleWalletId }).lean())?.balanceMinor, 500_000_000);

  const created = await createSession(createInput, lifecycleWalletId);
  const publicId = created.activeSessions[0]?.id;
  assert.ok(publicId);
  assert.equal((await WalletModel.findOne({ walletId: lifecycleWalletId }).lean())?.balanceMinor, 500_000_000);

  await Promise.allSettled(
    Array.from({ length: 20 }, () => topUpSession(publicId, lifecycleWalletId, 0.5, 'top-up-idempotency-key'))
  );
  const toppedUp = await SessionModel.findOne({ publicId }).lean();
  assert.equal(toppedUp?.limitMinor, 150_000_000);
  assert.equal(toppedUp?.lifecycleState, 'idle');
  assert.equal((await WalletModel.findOne({ walletId: lifecycleWalletId }).lean())?.balanceMinor, 500_000_000);

  await Promise.allSettled(
    Array.from({ length: 20 }, (_, index) => index % 2 === 0
      ? revokeSession(publicId, lifecycleWalletId, 'close-idempotency-key')
      : settleSession(publicId, lifecycleWalletId, 'close-idempotency-key'))
  );
  const closed = await SessionModel.findOne({ publicId }).lean();
  assert.ok(closed?.status === 'revoked' || closed?.status === 'settled');
  assert.equal(closed?.lifecycleState, 'idle');
  assert.equal((await WalletModel.findOne({ walletId: lifecycleWalletId }).lean())?.balanceMinor, 500_000_000);
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
