import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import mongoose from 'mongoose';
import { generateSecretKey } from 'nostr-tools/pure';
import request from 'supertest';
import { AuditLogModel } from '../models/auditLog.model.js';
import { AuthSessionModel } from '../models/auth.model.js';
import { PaymentDestinationModel, RecipientIdentityModel } from '../models/identity.model.js';
import { NwcConnectionModel, NwcPaymentModel } from '../models/nwc.model.js';
import { RateLimitBucketModel } from '../models/rateLimitBucket.model.js';
import { PaymentReceiptModel } from '../models/receipt.model.js';
import { PaymentScheduleModel, ScheduledOccurrenceModel } from '../models/schedule.model.js';
import { SessionModel } from '../models/session.model.js';
import { MockNwcRelayWallet } from './nwcTestWallet.js';

const uri = process.env.SCHEDULE_TEST_MONGODB_URI;
if (!uri) throw new Error('SCHEDULE_TEST_MONGODB_URI is required for scheduled-payment integration tests.');

process.env.NWC_SECRET_ENCRYPTION_KEY = '77'.repeat(32);
process.env.NWC_ALLOW_INSECURE_LOCAL_RELAY = 'true';
process.env.NWC_REQUEST_TIMEOUT_MS = '1000';
process.env.SCHEDULE_ALLOW_INSECURE_LOCAL_RESOLVERS = 'true';
process.env.SCHEDULE_RESOLVER_TIMEOUT_MS = '2000';
process.env.FIBERPASS_VAULT_CODE_HASH = '';
process.env.FIBERPASS_OPERATOR_LOCK_HASH = '';

const dbName = 'fiberpass_schedule_' + randomUUID().replace(/-/g, '');
await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10_000 });
const { app } = await import('../app.js');
const { decodeLightningInvoice } = await import('../connectors/nwcProtocol.js');
const { runDuePaymentSchedules } = await import('../services/paymentSchedule.service.js');

const lightningWallet = new MockNwcRelayWallet({
  network: 'regtest',
  balance: '100000000',
  budget: { total: '50000000', used: '0', enforced: true, resetsAt: Math.floor(Date.now() / 1000) + 3600 }
});
await lightningWallet.start();

const ownerWalletId = 'schedule-owner';
const recipientId = 'rcp_schedule_recipient';
const sessionId = 'schedule-pass';
const token = 'schedule-auth-token';
const authorization = 'Bearer ' + token;
const walletAddress = 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl';
let resolverRequests = 0;
let invoiceCounter = 0;
let failNextResolver = false;

const resolverServer = createServer((incoming, outgoing) => {
  if (incoming.method !== 'POST' || incoming.url !== '/fresh') {
    outgoing.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
  incoming.on('end', () => {
    resolverRequests += 1;
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      occurrenceId: string;
      recipientId: string;
      rail: string;
      network: string;
      assetId: string;
      amountAtomic: string;
    };
    assert.ok(body.occurrenceId.startsWith('occ_'));
    assert.equal(body.recipientId, recipientId);
    if (failNextResolver) {
      failNextResolver = false;
      outgoing.writeHead(503, { 'Content-Type': 'application/json' });
      outgoing.end(JSON.stringify({ error: 'temporary resolver outage' }));
      return;
    }
    invoiceCounter += 1;
    const preimage = invoiceCounter.toString(16).padStart(64, '0');
    const created = lightningWallet.createInvoice({ preimage, amount: body.amountAtomic, expirySeconds: 3600 });
    const decoded = decodeLightningInvoice({ invoice: created.invoice, network: 'regtest' });
    outgoing.writeHead(200, { 'Content-Type': 'application/json' });
    outgoing.end(JSON.stringify({
      paymentRequest: created.invoice,
      rail: body.rail,
      network: body.network,
      assetId: body.assetId,
      amountAtomic: body.amountAtomic,
      recipientId: body.recipientId,
      expiresAt: decoded.expiresAt
    }));
  });
});
resolverServer.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => resolverServer.once('listening', resolve));
const resolverAddress = resolverServer.address() as AddressInfo;
const resolverUrl = 'http://127.0.0.1:' + resolverAddress.port + '/fresh';

try {
  await Promise.all([
    AuditLogModel.syncIndexes(),
    AuthSessionModel.syncIndexes(),
    PaymentDestinationModel.syncIndexes(),
    RecipientIdentityModel.syncIndexes(),
    NwcConnectionModel.syncIndexes(),
    NwcPaymentModel.syncIndexes(),
    PaymentScheduleModel.syncIndexes(),
    ScheduledOccurrenceModel.syncIndexes(),
    PaymentReceiptModel.syncIndexes(),
    RateLimitBucketModel.syncIndexes(),
    SessionModel.syncIndexes()
  ]);
  await AuthSessionModel.create({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    walletId: ownerWalletId,
    address: walletAddress,
    expiresAt: new Date(Date.now() + 10 * 60_000)
  });
  await SessionModel.create({
    ownerWalletId,
    publicId: sessionId,
    name: 'Scheduled Lightning pass',
    serviceAddress: walletAddress,
    paymentPurpose: 'recurring_release',
    recipientWallets: [{ recipientId, name: 'Scheduled recipient', status: 'pending', destinationReusable: true }],
    releaseCadence: 'custom',
    limit: 1,
    limitMinor: 10_000_000,
    limitAtomic: '10000000',
    spent: 0,
    spentMinor: 0,
    spentAtomic: '0',
    reservedMinor: 0,
    reservedAtomic: '0',
    currency: 'BTC',
    assetId: 'bitcoin:btc',
    moneyContractVersion: 2,
    fundingMode: 'connected_wallet',
    fundingSourceId: 'fsrc_schedule_nwc',
    fundingGuarantee: 'authorization_only',
    fundingRiskLabel: 'none',
    fundingState: 'available',
    fundingExecutionReady: true,
    duration: 'test',
    expiryAt: new Date(Date.now() + 24 * 60 * 60_000),
    status: 'active',
    iconType: 'rpc',
    expiryTime: 'one day',
    autoMicroCharges: true,
    singleUse: false
  });
  await RecipientIdentityModel.create({
    recipientId,
    ownerWalletId,
    name: 'Scheduled recipient',
    sessionId,
    sessionRecipientIndex: 0
  });

  const clientSecret = generateSecretKey();
  const paired = await request(app)
    .post('/v2/wallet/nwc-connections')
    .set('Authorization', authorization)
    .send({
      connectionUri: lightningWallet.connectionUri(clientSecret),
      network: 'regtest',
      scopeType: 'wallet',
      executionMode: 'unattended'
    })
    .expect(201);
  assert.equal(paired.body.execution.unattendedEligible, true);
  const connectionId = paired.body.id as string;

  const destinationInput = {
    recipientId,
    rail: 'lightning',
    network: 'regtest',
    assetId: 'bitcoin:btc',
    kind: 'endpoint',
    value: resolverUrl
  };
  const destination = await request(app)
    .post('/v2/sessions/' + sessionId + '/payment-destinations')
    .set('Authorization', authorization)
    .set('Idempotency-Key', 'schedule-destination-create')
    .send(destinationInput)
    .expect(201);
  assert.equal(destination.body.reusable, true);
  assert.ok(!JSON.stringify(destination.body).includes(resolverUrl));
  const destinationReplay = await request(app)
    .post('/v2/sessions/' + sessionId + '/payment-destinations')
    .set('Authorization', authorization)
    .set('Idempotency-Key', 'schedule-destination-create')
    .send(destinationInput)
    .expect(201);
  assert.equal(destinationReplay.body.destinationId, destination.body.destinationId);
  await request(app)
    .post('/v2/sessions/' + sessionId + '/payment-destinations')
    .set('Authorization', authorization)
    .set('Idempotency-Key', 'schedule-destination-create')
    .send({ ...destinationInput, network: 'signet' })
    .expect(409);

  const base = new Date(Date.now() - 1000);
  const mainScheduleInput = {
    destinationId: destination.body.destinationId,
    rail: 'lightning',
    network: 'regtest',
    assetId: 'bitcoin:btc',
    amountAtomic: '1000000',
    executor: 'nwc',
    connectionId,
    cadence: 'custom',
    timeZone: 'Africa/Nairobi',
    firstOccurrenceAt: base.toISOString(),
    customIntervalSeconds: 60,
    occurrenceLimit: 3
  };
  const schedule = await request(app)
    .post('/v2/sessions/' + sessionId + '/payment-schedules')
    .set('Authorization', authorization)
    .set('Idempotency-Key', 'schedule-main-create')
    .send(mainScheduleInput)
    .expect(201);
  const scheduleId = schedule.body.id as string;
  const scheduleReplay = await request(app)
    .post('/v2/sessions/' + sessionId + '/payment-schedules')
    .set('Authorization', authorization)
    .set('Idempotency-Key', 'schedule-main-create')
    .send(mainScheduleInput)
    .expect(201);
  assert.equal(scheduleReplay.body.id, scheduleId);
  await request(app)
    .post('/v2/sessions/' + sessionId + '/payment-schedules')
    .set('Authorization', authorization)
    .set('Idempotency-Key', 'schedule-main-create')
    .send({ ...mainScheduleInput, amountAtomic: '2000000' })
    .expect(409);

  const firstRace = await Promise.all(Array.from({ length: 8 }, (_, index) => runDuePaymentSchedules({
    now: base,
    limit: 10,
    workerId: 'schedule-race-1-' + index
  })));
  assert.equal(firstRace.reduce((sum, item) => sum + item.succeeded, 0), 1);
  assert.equal(lightningWallet.payInvoiceCalls, 1);
  assert.equal(resolverRequests, 1);
  assert.equal(await ScheduledOccurrenceModel.countDocuments({ scheduleId }), 1);
  assert.equal((await SessionModel.findOne({ publicId: sessionId }).lean())?.spentAtomic, '1000000');
  assert.equal((await SessionModel.findOne({ publicId: sessionId }).lean())?.reservedAtomic, '0');

  lightningWallet.timeoutNextPay = true;
  const secondDue = new Date(base.getTime() + 60_000);
  const secondRace = await Promise.all(Array.from({ length: 8 }, (_, index) => runDuePaymentSchedules({
    now: secondDue,
    limit: 10,
    workerId: 'schedule-race-2-' + index
  })));
  assert.equal(secondRace.reduce((sum, item) => sum + item.pending, 0), 1);
  const callsAfterTimeout = lightningWallet.payInvoiceCalls;
  const reconciled = await runDuePaymentSchedules({ now: secondDue, limit: 10, workerId: 'schedule-reconcile' });
  assert.equal(reconciled.succeeded, 1);
  assert.equal(lightningWallet.payInvoiceCalls, callsAfterTimeout);
  assert.ok(lightningWallet.lookupInvoiceCalls >= 1);

  const thirdDue = new Date(base.getTime() + 120_000);
  const thirdRace = await Promise.all(Array.from({ length: 8 }, (_, index) => runDuePaymentSchedules({
    now: thirdDue,
    limit: 10,
    workerId: 'schedule-race-3-' + index
  })));
  assert.equal(thirdRace.reduce((sum, item) => sum + item.succeeded, 0), 1);
  assert.equal(lightningWallet.payInvoiceCalls, 3);
  assert.equal(resolverRequests, 3);

  const storedSchedule = await PaymentScheduleModel.findOne({ scheduleId }).lean();
  assert.equal(storedSchedule?.status, 'completed');
  assert.equal(storedSchedule?.occurrenceCount, 3);
  assert.equal(storedSchedule?.spentAtomic, '3000000');
  const occurrences = await ScheduledOccurrenceModel.find({ scheduleId }).sort({ dueAt: 1 }).lean();
  assert.equal(occurrences.length, 3);
  assert.equal(new Set(occurrences.map((item) => item.paymentRequestHash)).size, 3);
  assert.ok(occurrences.every((item) => item.status === 'succeeded' && item.reservationState === 'spent'));
  const rawOccurrence = await ScheduledOccurrenceModel.collection.findOne({ scheduleId });
  assert.equal(rawOccurrence?.paymentRequest, undefined);
  assert.equal(rawOccurrence?.preimage, undefined);

  const pausedDue = new Date(base.getTime() + 180_000);
  const pausable = await request(app)
    .post('/v2/sessions/' + sessionId + '/payment-schedules')
    .set('Authorization', authorization)
    .set('Idempotency-Key', 'schedule-pausable-create')
    .send({
      destinationId: destination.body.destinationId,
      rail: 'lightning',
      network: 'regtest',
      assetId: 'bitcoin:btc',
      amountAtomic: '1000000',
      executor: 'nwc',
      connectionId,
      cadence: 'custom',
      timeZone: 'UTC',
      firstOccurrenceAt: pausedDue.toISOString(),
      customIntervalSeconds: 60
    })
    .expect(201);
  await request(app)
    .post('/v2/payment-schedules/' + pausable.body.id + '/control')
    .set('Authorization', authorization)
    .send({ action: 'pause' })
    .expect(200);
  const callsBeforePause = lightningWallet.payInvoiceCalls;
  await runDuePaymentSchedules({ now: pausedDue, workerId: 'paused-gate' });
  assert.equal(lightningWallet.payInvoiceCalls, callsBeforePause);
  await request(app)
    .post('/v2/payment-schedules/' + pausable.body.id + '/control')
    .set('Authorization', authorization)
    .send({ action: 'resume' })
    .expect(200);
  lightningWallet.timeoutNextPay = true;
  assert.equal((await runDuePaymentSchedules({ now: pausedDue, workerId: 'resumed-gate' })).pending, 1);
  await request(app)
    .post('/v2/payment-schedules/' + pausable.body.id + '/control')
    .set('Authorization', authorization)
    .send({ action: 'pause' })
    .expect(200);
  assert.equal((await runDuePaymentSchedules({ now: pausedDue, workerId: 'paused-reconciliation' })).succeeded, 1);
  assert.equal((await PaymentScheduleModel.findOne({ scheduleId: pausable.body.id }).lean())?.status, 'paused');
  await request(app)
    .post('/v2/payment-schedules/' + pausable.body.id + '/control')
    .set('Authorization', authorization)
    .send({ action: 'revoke' })
    .expect(200);
  await runDuePaymentSchedules({ now: new Date(pausedDue.getTime() + 60_000), workerId: 'revoked-gate' });
  assert.equal(lightningWallet.payInvoiceCalls, callsBeforePause + 1);

  const passPauseDue = new Date(base.getTime() + 240_000);
  const passPause = await request(app)
    .post('/v2/sessions/' + sessionId + '/payment-schedules')
    .set('Authorization', authorization)
    .set('Idempotency-Key', 'schedule-pass-pause-create')
    .send({
      destinationId: destination.body.destinationId,
      rail: 'lightning',
      network: 'regtest',
      assetId: 'bitcoin:btc',
      amountAtomic: '1000000',
      executor: 'nwc',
      connectionId,
      cadence: 'once',
      timeZone: 'UTC',
      firstOccurrenceAt: passPauseDue.toISOString()
    })
    .expect(201);
  await SessionModel.updateOne({ publicId: sessionId }, { $set: { status: 'paused' } });
  await runDuePaymentSchedules({ now: passPauseDue, workerId: 'pass-paused-gate' });
  assert.equal(await ScheduledOccurrenceModel.countDocuments({ scheduleId: passPause.body.id }), 0);
  await SessionModel.updateOne({ publicId: sessionId }, { $set: { status: 'active' } });
  await request(app)
    .post('/v2/payment-schedules/' + passPause.body.id + '/control')
    .set('Authorization', authorization)
    .send({ action: 'revoke' })
    .expect(200);

  const passRevokeDue = new Date(base.getTime() + 270_000);
  const passRevoke = await request(app)
    .post('/v2/sessions/' + sessionId + '/payment-schedules')
    .set('Authorization', authorization)
    .set('Idempotency-Key', 'schedule-pass-revoke-create')
    .send({
      destinationId: destination.body.destinationId,
      rail: 'lightning',
      network: 'regtest',
      assetId: 'bitcoin:btc',
      amountAtomic: '1000000',
      executor: 'nwc',
      connectionId,
      cadence: 'once',
      timeZone: 'UTC',
      firstOccurrenceAt: passRevokeDue.toISOString()
    })
    .expect(201);
  failNextResolver = true;
  assert.equal((await runDuePaymentSchedules({ now: passRevokeDue, workerId: 'pass-revoke-resolver-failure' })).retrying, 1);
  assert.equal((await SessionModel.findOne({ publicId: sessionId }).lean())?.reservedAtomic, '1000000');
  await SessionModel.updateOne({ publicId: sessionId }, { $set: { status: 'revoked' } });
  await runDuePaymentSchedules({ now: new Date(passRevokeDue.getTime() + 31_000), workerId: 'pass-revoke-cleanup' });
  assert.equal((await PaymentScheduleModel.findOne({ scheduleId: passRevoke.body.id }).lean())?.status, 'revoked');
  assert.equal((await SessionModel.findOne({ publicId: sessionId }).lean())?.reservedAtomic, '0');
  await SessionModel.updateOne({ publicId: sessionId }, { $set: { status: 'active' } });

  const depletedDue = new Date(base.getTime() + 300_000);
  const depleted = await request(app)
    .post('/v2/sessions/' + sessionId + '/payment-schedules')
    .set('Authorization', authorization)
    .set('Idempotency-Key', 'schedule-depleted-create')
    .send({
      destinationId: destination.body.destinationId,
      rail: 'lightning',
      network: 'regtest',
      assetId: 'bitcoin:btc',
      amountAtomic: '1000000',
      executor: 'nwc',
      connectionId,
      cadence: 'once',
      timeZone: 'UTC',
      firstOccurrenceAt: depletedDue.toISOString()
    })
    .expect(201);
  await SessionModel.updateOne({ publicId: sessionId }, { $set: { spent: 1, spentMinor: 10_000_000, spentAtomic: '10000000' } });
  await runDuePaymentSchedules({ now: depletedDue, workerId: 'depleted-gate' });
  assert.equal((await PaymentScheduleModel.findOne({ scheduleId: depleted.body.id }).lean())?.status, 'depleted');
  assert.equal(lightningWallet.payInvoiceCalls, callsBeforePause + 1);

  await SessionModel.updateOne({ publicId: sessionId }, { $set: { spent: 0.04, spentMinor: 4_000_000, spentAtomic: '4000000', reservedMinor: 0, reservedAtomic: '0' } });
  const expiryDue = new Date(base.getTime() + 360_000);
  const expiring = await request(app)
    .post('/v2/sessions/' + sessionId + '/payment-schedules')
    .set('Authorization', authorization)
    .set('Idempotency-Key', 'schedule-expiring-create')
    .send({
      destinationId: destination.body.destinationId,
      rail: 'lightning',
      network: 'regtest',
      assetId: 'bitcoin:btc',
      amountAtomic: '1000000',
      executor: 'nwc',
      connectionId,
      cadence: 'once',
      timeZone: 'UTC',
      firstOccurrenceAt: expiryDue.toISOString()
    })
    .expect(201);
  await SessionModel.updateOne({ publicId: sessionId }, { $set: { expiryAt: new Date(expiryDue.getTime() - 1) } });
  await runDuePaymentSchedules({ now: expiryDue, workerId: 'expiry-gate' });
  assert.equal((await PaymentScheduleModel.findOne({ scheduleId: expiring.body.id }).lean())?.status, 'expired');
  assert.equal(lightningWallet.payInvoiceCalls, callsBeforePause + 1);

  const listed = await request(app)
    .get('/v2/sessions/' + sessionId + '/payment-schedules')
    .set('Authorization', authorization)
    .expect(200);
  assert.ok(listed.body.schedules.length >= 5);
  assert.ok(listed.body.occurrences.every((item: Record<string, unknown>) => !('paymentRequest' in item)));
  assert.equal(await AuditLogModel.countDocuments({ action: 'schedule.occurrence.succeeded' }), 4);
} finally {
  resolverServer.close();
  await lightningWallet.close();
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
