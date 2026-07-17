import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { FundingAllocationModel, FundingSourceModel } from '../models/fundingSource.model.js';
import {
  ClaimChannelModel,
  NotificationEndpointModel,
  PaymentDestinationModel,
  RecipientClaimModel,
  RecipientIdentityModel,
  WalletPrincipalModel
} from '../models/identity.model.js';
import { SessionModel } from '../models/session.model.js';
import { WalletModel } from '../models/wallet.model.js';

const uri = process.env.FUNDING_TEST_MONGODB_URI;
if (!uri) throw new Error('FUNDING_TEST_MONGODB_URI is required for funding integration tests.');

process.env.FIBERPASS_VAULT_CODE_HASH = '';
process.env.FIBERPASS_OPERATOR_LOCK_HASH = '';
process.env.FIBER_NETWORK = 'testnet';

const {
  fundingExecutionStatus,
  recordConnectedWalletBalance,
  recordSecuredFundingProof,
  releaseFundingAllocationTransaction,
  resolveFundingSelection,
  spendFundingAllocation,
  toFundingSourceDto
} = await import('../services/fundingSource.service.js');
const { createSession, revokeSession } = await import('../services/session.service.js');

const dbName = 'fiberpass_funding_' + randomUUID().replace(/-/g, '');
await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10_000 });

const walletAddress = 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl';
const ownerWalletId = 'funding-owner';

try {
  await Promise.all([
    FundingAllocationModel.syncIndexes(),
    FundingSourceModel.syncIndexes(),
    SessionModel.syncIndexes(),
    WalletModel.syncIndexes(),
    WalletPrincipalModel.syncIndexes(),
    RecipientIdentityModel.syncIndexes(),
    PaymentDestinationModel.syncIndexes(),
    ClaimChannelModel.syncIndexes(),
    NotificationEndpointModel.syncIndexes(),
    RecipientClaimModel.syncIndexes()
  ]);
  await WalletModel.create({
    walletId: ownerWalletId,
    connected: true,
    address: walletAddress,
    balance: 0,
    balanceMinor: 0,
    currency: 'CKB'
  });
  let securedSourceId = '';
  await mongoose.connection.transaction(async (mongoSession) => {
    securedSourceId = await recordSecuredFundingProof({
      ownerWalletId,
      sourceReference: '0xsecured-contract-script',
      amountMinor: 10_000_000_000,
      proofId: '0x' + '11'.repeat(32) + ':0x0',
      proofType: 'ckb_out_point',
      observedAt: new Date(),
      session: mongoSession
    });
  });

  const createInput = {
    serviceAddress: walletAddress,
    limit: 10,
    currency: 'CKB',
    duration: 'funding concurrency',
    expiryTime: 'No expiry',
    autoMicroCharges: true,
    singleUse: false,
    iconType: 'rpc' as const,
    fundingMode: 'secured_autopay' as const,
    fundingSourceId: securedSourceId
  };
  const creations = await Promise.allSettled(Array.from({ length: 20 }, (_, index) => createSession({
    ...createInput,
    name: 'Secured pass ' + index
  }, ownerWalletId)));
  assert.equal(creations.filter((result) => result.status === 'fulfilled').length, 10);
  assert.equal(creations.filter((result) => (
    result.status === 'rejected'
    && (result.reason as { code?: string }).code === 'SECURED_FUNDING_INSUFFICIENT'
  )).length, 10);
  assert.equal(await FundingAllocationModel.countDocuments({ ownerWalletId, mode: 'secured_autopay' }), 10);
  let securedSource = await FundingSourceModel.findOne({ sourceId: securedSourceId }).lean();
  assert.equal(securedSource?.lockedMinor, 10_000_000_000);
  assert.equal(securedSource?.reservedMinor, 10_000_000_000);
  assert.equal(securedSource?.authorizedMinor, 10_000_000_000);
  assert.equal(securedSource?.reclaimableMinor, 0);
  assert.equal(securedSource?.state, 'fully_allocated');

  const firstPass = await SessionModel.findOne({ ownerWalletId, status: 'active' }).sort({ createdAt: 1 }).lean();
  assert.ok(firstPass);
  await revokeSession(firstPass.publicId, ownerWalletId, 'funding-release-idempotency');
  await revokeSession(firstPass.publicId, ownerWalletId, 'funding-release-idempotency');
  securedSource = await FundingSourceModel.findOne({ sourceId: securedSourceId }).lean();
  assert.equal(securedSource?.reservedMinor, 9_000_000_000);
  assert.equal(securedSource?.authorizedMinor, 9_000_000_000);
  assert.equal(securedSource?.releasedMinor, 1_000_000_000);
  assert.equal(securedSource?.reclaimableMinor, 1_000_000_000);
  assert.equal(await releaseFundingAllocationTransaction(firstPass.publicId), 0);

  const spendPass = await SessionModel.findOne({ ownerWalletId, status: 'active' }).sort({ createdAt: 1 }).lean();
  assert.ok(spendPass);
  await mongoose.connection.transaction(async (mongoSession) => {
    assert.equal(await spendFundingAllocation(spendPass.publicId, 200_000_000, mongoSession), true);
  });
  assert.equal(await releaseFundingAllocationTransaction(spendPass.publicId), 800_000_000);
  assert.equal(await releaseFundingAllocationTransaction(spendPass.publicId), 0);
  securedSource = await FundingSourceModel.findOne({ sourceId: securedSourceId }).lean();
  assert.equal(securedSource?.lockedMinor, 9_800_000_000);
  assert.equal(securedSource?.reservedMinor, 8_000_000_000);
  assert.equal(securedSource?.authorizedMinor, 8_000_000_000);
  assert.equal(securedSource?.spentMinor, 200_000_000);
  assert.equal(securedSource?.releasedMinor, 1_800_000_000);
  assert.equal(securedSource?.reclaimableMinor, 1_800_000_000);

  const connected = await createSession({
    ...createInput,
    name: 'Connected wallet policy pass',
    limit: 100,
    fundingMode: 'connected_wallet',
    fundingSourceId: undefined
  }, ownerWalletId);
  const connectedPassId = connected.activeSessions.find((session) => session.name === 'Connected wallet policy pass')?.id;
  assert.ok(connectedPassId);
  assert.equal(connected.wallet.balanceSource, 'legacy_compatibility_projection');
  const connectedSourceDto = connected.wallet.fundingSources.find((source) => source.mode === 'connected_wallet');
  assert.equal(connectedSourceDto?.rail, 'ckb_onchain');
  assert.equal(connectedSourceDto?.assetId, 'ckb:ckb');
  assert.equal(connectedSourceDto?.guarantee, 'authorization_only');
  assert.equal(connectedSourceDto?.freshness.stale, false);
  const connectedPass = connected.activeSessions.find((session) => session.id === connectedPassId);
  assert.equal(connectedPass?.funding?.mode, 'connected_wallet');
  assert.equal(connectedPass?.funding?.allocation?.authorizedAtomic, '10000000000');
  assert.equal(connectedPass?.funding?.mongoExecutionReservationAtomic, '0');
  let connectedStatus = await fundingExecutionStatus(connectedPassId, 10_000_000_000);
  assert.equal(connectedStatus.code, 'CONNECTED_WALLET_BALANCE_UNVERIFIED');
  await recordConnectedWalletBalance({ ownerWalletId, walletAddress, availableMinor: 5_000_000_000 });
  connectedStatus = await fundingExecutionStatus(connectedPassId, 10_000_000_000);
  assert.equal(connectedStatus.code, 'CONNECTED_WALLET_LIQUIDITY_INSUFFICIENT');
  assert.equal((await FundingSourceModel.findOne({ sourceId: connectedSourceDto?.id }).lean())?.state, 'insufficient');
  await recordConnectedWalletBalance({ ownerWalletId, walletAddress, availableMinor: 20_000_000_000 });
  connectedStatus = await fundingExecutionStatus(connectedPassId, 10_000_000_000);
  assert.equal(connectedStatus.ready, true);
  assert.equal((await FundingSourceModel.findOne({ sourceId: connectedSourceDto?.id }).lean())?.state, 'available');
  assert.equal((await SessionModel.findOne({ publicId: connectedPassId }).lean())?.status, 'active');

  await FundingSourceModel.updateOne(
    { sourceId: securedSourceId },
    { $set: { state: 'available', staleAt: new Date(Date.now() - 1_000) } }
  );
  const staleSecuredSource = await FundingSourceModel.findOne({ sourceId: securedSourceId }).lean();
  assert.ok(staleSecuredSource);
  assert.equal(toFundingSourceDto(staleSecuredSource).state, 'stale');
  const defaultSelection = await resolveFundingSelection({
    ownerWalletId,
    walletAddress,
    amountMinor: 100_000_000
  });
  assert.equal(defaultSelection.mode, 'connected_wallet');

  await FundingSourceModel.create({
    sourceId: 'unproved-secured-source',
    ownerWalletId,
    mode: 'secured_autopay',
    sourceKind: 'network_contract',
    sourceReference: 'unproved-contract',
    rail: 'ckb_onchain',
    network: 'testnet',
    assetId: 'ckb:ckb',
    moneyContractVersion: 2,
    guarantee: 'network_locked',
    riskLabel: 'none',
    state: 'unverified',
    availableMinor: 0,
    availableAtomic: '0',
    authorizedMinor: 0,
    authorizedAtomic: '0',
    lockedMinor: 0,
    lockedAtomic: '0',
    reservedMinor: 0,
    reservedAtomic: '0',
    spentMinor: 0,
    spentAtomic: '0',
    releasedMinor: 0,
    releasedAtomic: '0',
    reclaimableMinor: 0,
    reclaimableAtomic: '0'
  });
  const unprovedSelection = await resolveFundingSelection({
    ownerWalletId,
    walletAddress,
    amountMinor: 100_000_000,
    mode: 'secured_autopay',
    sourceId: 'unproved-secured-source'
  });
  await assert.rejects(
    () => createSession({
      ...createInput,
      name: 'Unproved secured pass',
      limit: 1,
      fundingSourceId: unprovedSelection.sourceId
    }, ownerWalletId),
    (error: unknown) => (error as { code?: string }).code === 'SECURED_FUNDING_PROOF_REQUIRED'
  );
  assert.equal(await SessionModel.countDocuments({ name: 'Unproved secured pass' }), 0);
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
