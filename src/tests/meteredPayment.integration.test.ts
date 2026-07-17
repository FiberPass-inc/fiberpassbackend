import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import type { ResolverTransport } from '../connectors/destinationResolverClient.js';
import { decodeLightningInvoice } from '../connectors/nwcProtocol.js';
import { ApiError } from '../lib/errors.js';
import { AppModel } from '../models/app.model.js';
import { AuditLogModel } from '../models/auditLog.model.js';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import { PaymentDestinationModel } from '../models/identity.model.js';
import {
  MeteredBatchModel,
  MeteredGrantModel,
  MeteredRateCounterModel,
  UsageEventModel
} from '../models/meteredPayment.model.js';
import { SessionModel } from '../models/session.model.js';
import { NwcConnectionModel } from '../models/nwc.model.js';
import {
  createMeteredGrant,
  revokeMeteredGrant,
  submitUsageEvent,
  type MeteredActor
} from '../services/meteredPayment.service.js';
import {
  runMeteredPaymentWorker,
  type MeteredBatchExecutor,
  type MeteredExecutionResult
} from '../services/meteredPaymentWorker.service.js';
import { MockNwcRelayWallet } from './nwcTestWallet.js';

const uri = process.env.METERED_TEST_MONGODB_URI;
if (!uri) throw new Error('METERED_TEST_MONGODB_URI is required for metered-payment integration tests.');

const dbName = 'fiberpass_metered_' + randomUUID().replace(/-/g, '');
await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10_000 });

const ownerWalletId = 'metered-owner';
const appId = 'app-metered';
const serviceAddress = 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl';
const ownerActor: MeteredActor = { appId, ownerWalletId, source: 'wallet' };
const appActor: MeteredActor = { appId, ownerWalletId, source: 'app_api_key', keyId: 'key-metered' };
const invoiceWallet = new MockNwcRelayWallet({ network: 'regtest' });
let invoiceCounter = 0;

const resolverTransport: ResolverTransport = {
  async requestJson(input) {
    const body = input.body as {
      occurrenceId: string;
      recipientId: string;
      rail: string;
      network: string;
      assetId: string;
      amountAtomic: string;
    };
    invoiceCounter += 1;
    const preimage = invoiceCounter.toString(16).padStart(64, '0');
    const invoice = invoiceWallet.createInvoice({
      preimage,
      amount: body.amountAtomic,
      expirySeconds: 3600
    });
    const decoded = decodeLightningInvoice({ invoice: invoice.invoice, network: 'regtest' });
    return {
      paymentRequest: invoice.invoice,
      rail: body.rail,
      network: body.network,
      assetId: body.assetId,
      amountAtomic: body.amountAtomic,
      recipientId: body.recipientId,
      expiresAt: decoded.expiresAt
    };
  }
};

interface Fixture {
  sessionId: string;
  recipientId: string;
  destinationId: string;
  grantId: string;
}

let fixtureCounter = 0;
async function createFixture(options: {
  total?: string;
  maxPerEvent?: string;
  threshold?: string;
  maxBatch?: string;
  maxBatchEvents?: number;
  delayMs?: number;
  rateLimit?: number;
} = {}): Promise<Fixture> {
  fixtureCounter += 1;
  const suffix = fixtureCounter.toString();
  const sessionId = 'metered-pass-' + suffix;
  const recipientId = 'metered-recipient-' + suffix;
  const destinationId = 'metered-destination-' + suffix;
  const total = options.total ?? '10000';
  await SessionModel.create({
    ownerWalletId,
    publicId: sessionId,
    name: 'Metered pass ' + suffix,
    serviceAddress,
    appId,
    appPermissions: ['charges:create'],
    appGrantOwnerWalletId: ownerWalletId,
    appGrantCreatedAt: new Date(),
    paymentPurpose: 'app_session',
    spent: 0,
    spentMinor: 0,
    spentAtomic: '0',
    reservedMinor: 0,
    reservedAtomic: '0',
    limit: Math.max(0.01, Number(total) / 100_000_000),
    limitMinor: Number(total),
    limitAtomic: total,
    currency: 'BTC',
    assetId: 'bitcoin:btc',
    moneyContractVersion: 2,
    duration: 'integration',
    status: 'active',
    iconType: 'rpc',
    expiryTime: 'one hour',
    expiryAt: new Date(Date.now() + 60 * 60_000),
    lifecycleState: 'idle',
    autoMicroCharges: true,
    singleUse: false,
    logs: []
  });
  await PaymentDestinationModel.create({
    destinationId,
    recipientId,
    ownerWalletId,
    rail: 'lightning',
    network: 'regtest',
    assetId: 'bitcoin:btc',
    kind: 'endpoint',
    value: 'https://resolver.example/' + suffix,
    valueHash: createHash('sha256').update('resolver-' + suffix).digest('hex'),
    reusable: true,
    status: 'active',
    verificationMethod: 'owner_configured',
    verificationScope: 'delivery_instruction',
    verifiedAt: new Date()
  });
  await NwcConnectionModel.create({
    connectionId: 'test-nwc-' + suffix,
    ownerWalletId,
    scopeType: 'pass',
    scopeId: sessionId,
    status: 'active',
    executionMode: 'unattended',
    walletPubkey: suffix.padStart(64, '1').slice(-64),
    clientPubkey: suffix.padStart(64, '2').slice(-64),
    clientKeyFingerprint: createHash('sha256').update('client-' + suffix).digest('hex'),
    relayUrls: ['wss://relay.example'],
    selectedRelay: 'wss://relay.example',
    secretCiphertext: 'test-only-ciphertext-' + suffix,
    encryption: 'nip44_v2',
    methods: ['pay_invoice', 'lookup_invoice'],
    advertisedMethods: ['pay_invoice', 'lookup_invoice'],
    notifications: [],
    infoEventId: suffix.padStart(64, '3').slice(-64),
    network: 'regtest',
    assetId: 'bitcoin:btc',
    moneyContractVersion: 2,
    allowanceEnforced: true,
    allowanceAtomic: total,
    allowanceUsedAtomic: '0',
    allowanceProofEventId: suffix.padStart(64, '4').slice(-64),
    balanceAtomic: total
  });
  const grant = await createMeteredGrant(ownerActor, {
    sessionId,
    recipientId,
    destinationId,
    rail: 'lightning',
    network: 'regtest',
    assetId: 'bitcoin:btc',
    executor: 'nwc',
    connectionId: 'test-nwc-' + suffix,
    maxPerEventAtomic: options.maxPerEvent ?? '100',
    totalLimitAtomic: total,
    rateLimitCount: options.rateLimit ?? 1000,
    rateLimitWindowSeconds: 60,
    immediateThresholdAtomic: options.threshold ?? '20',
    maxBatchAtomic: options.maxBatch ?? '50',
    maxBatchEvents: options.maxBatchEvents ?? 50,
    settlementDelayMs: options.delayMs ?? 1000,
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString()
  });
  return { sessionId, recipientId, destinationId, grantId: grant.id };
}

function succeedingExecutor(calls: string[] = []): MeteredBatchExecutor {
  return {
    async execute(input, markSubmitted) {
      calls.push(input.batchId);
      await markSubmitted('provider-' + input.batchId);
      return {
        status: 'succeeded',
        providerPaymentId: 'provider-' + input.batchId,
        paymentHash: input.paymentHash,
        proofKind: 'payment_hash',
        proofReference: input.paymentHash ?? 'proof-' + input.batchId
      };
    },
    async lookup() {
      return undefined;
    }
  };
}

try {
  await Promise.all([
    AppModel.syncIndexes(),
    AuditLogModel.syncIndexes(),
    ChargeAttemptModel.syncIndexes(),
    PaymentDestinationModel.syncIndexes(),
    MeteredGrantModel.syncIndexes(),
    MeteredBatchModel.syncIndexes(),
    MeteredRateCounterModel.syncIndexes(),
    UsageEventModel.syncIndexes(),
    NwcConnectionModel.syncIndexes(),
    SessionModel.syncIndexes()
  ]);
  await AppModel.create({
    appId,
    ownerWalletId,
    name: 'Metered integration app',
    serviceAddress,
    status: 'active'
  });

  const duplicateFixture = await createFixture({ total: '100', maxPerEvent: '10', threshold: '50' });
  const duplicates = await Promise.all(Array.from({ length: 24 }, () => submitUsageEvent(appActor, {
    grantId: duplicateFixture.grantId,
    externalId: 'duplicate-event',
    amountAtomic: '10',
    policyReference: 'policy-duplicate'
  })));
  assert.equal(new Set(duplicates.map((event) => event.id)).size, 1);
  assert.equal(await UsageEventModel.countDocuments({
    appId,
    externalId: 'duplicate-event'
  }), 1);
  assert.equal((await SessionModel.findOne({ publicId: duplicateFixture.sessionId }).lean())?.reservedAtomic, '10');
  await assert.rejects(() => submitUsageEvent(appActor, {
    grantId: duplicateFixture.grantId,
    externalId: 'duplicate-event',
    amountAtomic: '9'
  }), (error: unknown) => (error as { code?: string }).code === 'USAGE_EVENT_IDEMPOTENCY_CONFLICT');

  const volumeFixture = await createFixture({
    total: '80',
    maxPerEvent: '1',
    threshold: '20',
    maxBatch: '25',
    maxBatchEvents: 25,
    delayMs: 1
  });
  const accepted = await Promise.all(Array.from({ length: 80 }, (_, index) => submitUsageEvent(appActor, {
    grantId: volumeFixture.grantId,
    externalId: 'volume-' + index,
    amountAtomic: '1',
    policyReference: 'policy-volume'
  })));
  assert.equal(accepted.length, 80);
  assert.equal(new Set(accepted.map((event) => event.id)).size, 80);
  const reservedVolumeSession = await SessionModel.findOne({ publicId: volumeFixture.sessionId }).lean();
  assert.equal(reservedVolumeSession?.reservedAtomic, '80');
  assert.equal(reservedVolumeSession?.spentAtomic, '0');
  const volumeBatches = await MeteredBatchModel.find({ grantId: volumeFixture.grantId }).lean();
  assert.equal(volumeBatches.reduce((sum, batch) => sum + BigInt(batch.totalAtomic), 0n), 80n);
  for (const batch of volumeBatches) {
    assert.ok(batch.eventCount <= 25);
    assert.ok(BigInt(batch.totalAtomic) <= 25n);
    assert.equal(batch.ownerWalletId, ownerWalletId);
    assert.equal(batch.sessionId, volumeFixture.sessionId);
    assert.equal(batch.recipientId, volumeFixture.recipientId);
    assert.equal(batch.assetId, 'bitcoin:btc');
    assert.equal(batch.rail, 'lightning');
  }
  const volumeCalls: string[] = [];
  const volumeResults = await Promise.all(Array.from({ length: 8 }, (_, index) => runMeteredPaymentWorker({
    limit: 20,
    workerId: 'volume-worker-' + index,
    now: new Date(Date.now() + 5000),
    executor: succeedingExecutor(volumeCalls),
    resolverTransport
  })));
  assert.ok(volumeResults.reduce((sum, result) => sum + result.succeeded, 0) >= volumeBatches.length);
  const volumeBatchIds = new Set(volumeBatches.map((batch) => batch.batchId));
  const targetCalls = volumeCalls.filter((batchId) => volumeBatchIds.has(batchId));
  assert.equal(targetCalls.length, volumeBatches.length);
  assert.equal(new Set(targetCalls).size, volumeBatches.length);
  const settledVolumeSession = await SessionModel.findOne({ publicId: volumeFixture.sessionId }).lean();
  assert.equal(settledVolumeSession?.reservedAtomic, '0');
  assert.equal(settledVolumeSession?.spentAtomic, '80');
  assert.equal(await UsageEventModel.countDocuments({ grantId: volumeFixture.grantId, status: 'settled' }), 80);
  assert.equal(await UsageEventModel.countDocuments({
    grantId: volumeFixture.grantId,
    receiptId: { $exists: true },
    proofReference: { $exists: true }
  }), 80);

  const restartFixture = await createFixture({ total: '20', maxPerEvent: '20', threshold: '1', maxBatch: '20' });
  const restartEvent = await submitUsageEvent(appActor, {
    grantId: restartFixture.grantId,
    externalId: 'restart-event',
    amountAtomic: '7'
  });
  let executeCalls = 0;
  let lookupCalls = 0;
  const restartExecutor: MeteredBatchExecutor = {
    async execute(input, markSubmitted): Promise<MeteredExecutionResult> {
      executeCalls += 1;
      await markSubmitted('restart-provider');
      throw new ApiError(503, 'TEST_FORCED_UNCERTAIN', 'Simulated process loss after provider submission.');
    },
    async lookup(batch) {
      lookupCalls += 1;
      return {
        status: 'succeeded',
        providerPaymentId: 'restart-provider',
        paymentHash: batch.paymentHash ?? undefined,
        proofKind: 'payment_hash',
        proofReference: batch.paymentHash ?? 'restart-proof'
      };
    }
  };
  const firstRestartRun = await runMeteredPaymentWorker({
    limit: 1,
    workerId: 'restart-worker-a',
    now: new Date(Date.now() + 5000),
    executor: restartExecutor,
    resolverTransport
  });
  assert.equal(firstRestartRun.retried, 1);
  const secondRestartRun = await runMeteredPaymentWorker({
    limit: 1,
    workerId: 'restart-worker-b',
    now: new Date(Date.now() + 60_000),
    executor: restartExecutor,
    resolverTransport
  });
  assert.equal(secondRestartRun.succeeded, 1);
  assert.equal(executeCalls, 1);
  assert.equal(lookupCalls, 1);
  assert.equal((await UsageEventModel.findOne({ eventId: restartEvent.id }).lean())?.status, 'settled');
  assert.equal((await SessionModel.findOne({ publicId: restartFixture.sessionId }).lean())?.spentAtomic, '7');

  const failedFixture = await createFixture({ total: '20', maxPerEvent: '20', threshold: '1', maxBatch: '20' });
  const failedEvent = await submitUsageEvent(appActor, {
    grantId: failedFixture.grantId,
    externalId: 'failed-event',
    amountAtomic: '6'
  });
  const failingExecutor: MeteredBatchExecutor = {
    async execute(_input, markSubmitted) {
      await markSubmitted('failed-provider');
      return {
        status: 'failed',
        failureCode: 'TEST_PROVIDER_REJECTED',
        failureMessage: 'Deterministic provider rejection.'
      };
    },
    async lookup() {
      return undefined;
    }
  };
  const failedRun = await runMeteredPaymentWorker({
    limit: 1,
    workerId: 'failure-worker',
    now: new Date(Date.now() + 5000),
    executor: failingExecutor,
    resolverTransport
  });
  assert.equal(failedRun.released, 1);
  assert.equal((await SessionModel.findOne({ publicId: failedFixture.sessionId }).lean())?.reservedAtomic, '0');
  assert.equal((await SessionModel.findOne({ publicId: failedFixture.sessionId }).lean())?.spentAtomic, '0');
  assert.equal((await UsageEventModel.findOne({ eventId: failedEvent.id }).lean())?.status, 'failed');
  assert.equal((await ChargeAttemptModel.findOne({ attemptId: failedEvent.id }).lean())?.reserveStatus, 'released');

  const revokedFixture = await createFixture({ total: '20', maxPerEvent: '20', threshold: '20', delayMs: 60_000 });
  const revokedEvent = await submitUsageEvent(appActor, {
    grantId: revokedFixture.grantId,
    externalId: 'revoked-event',
    amountAtomic: '5'
  });
  const revoked = await revokeMeteredGrant(ownerActor, revokedFixture.grantId);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.reservedAtomic, '0');
  assert.equal((await UsageEventModel.findOne({ eventId: revokedEvent.id }).lean())?.status, 'released');
  assert.equal((await SessionModel.findOne({ publicId: revokedFixture.sessionId }).lean())?.reservedAtomic, '0');
  await assert.rejects(() => submitUsageEvent(appActor, {
    grantId: revokedFixture.grantId,
    externalId: 'after-revoke',
    amountAtomic: '1'
  }), (error: unknown) => (error as { code?: string }).code === 'METERED_GRANT_INACTIVE');

  const rateFixture = await createFixture({ total: '20', maxPerEvent: '10', rateLimit: 2, threshold: '20' });
  await submitUsageEvent(appActor, { grantId: rateFixture.grantId, externalId: 'rate-1', amountAtomic: '1' });
  await submitUsageEvent(appActor, { grantId: rateFixture.grantId, externalId: 'rate-2', amountAtomic: '1' });
  await assert.rejects(() => submitUsageEvent(appActor, {
    grantId: rateFixture.grantId,
    externalId: 'rate-3',
    amountAtomic: '1'
  }), (error: unknown) => (error as { code?: string }).code === 'METERED_RATE_LIMIT_EXCEEDED');
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
