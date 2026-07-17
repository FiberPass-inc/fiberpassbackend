import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { AuthSessionModel } from '../models/auth.model.js';
import {
  NotificationEndpointModel,
  RecipientIdentityModel
} from '../models/identity.model.js';
import { RateLimitBucketModel } from '../models/rateLimitBucket.model.js';
import {
  NotificationDeliveryModel,
  PaymentReceiptModel,
  type PaymentReceiptRecord
} from '../models/receipt.model.js';
import { createPaymentReceipt, queueReceiptNotifications } from '../services/receipt.service.js';

const uri = process.env.RECEIPT_TEST_MONGODB_URI;
if (!uri) throw new Error('RECEIPT_TEST_MONGODB_URI is required for receipt notification integration tests.');

process.env.RATE_LIMIT_STORE = 'memory';
process.env.NOTIFICATION_TOKEN_SECRET = 'receipt-test-notification-secret-' + '1'.repeat(32);
process.env.NOSTR_NOTIFICATION_ALLOW_INSECURE_LOCAL_RELAY = 'true';
process.env.FIBERPASS_VAULT_CODE_HASH = '';
process.env.FIBERPASS_OPERATOR_LOCK_HASH = '';

const dbName = 'fiberpass_receipts_' + randomUUID().replace(/-/g, '');
await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10_000 });
const { app } = await import('../app.js');
const {
  runReceiptNotificationWorker
} = await import('../services/notification.service.js');
import type { NotificationTransport } from '../services/notification.service.js';

const ownerWalletId = 'receipt-owner';
const recipientId = 'receipt-recipient';
const token = 'receipt-auth-token';
const authorization = 'Bearer ' + token;
const walletAddress = 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl';

async function addReceipt(sourceId: string, amountAtomic = '2500'): Promise<string> {
  let receiptId = '';
  await PaymentReceiptModel.db.transaction(async (session) => {
    receiptId = await createPaymentReceipt({
      ownerWalletId,
      recipientId,
      sourceType: 'usage_event',
      sourceId,
      settlementId: 'settlement-' + sourceId,
      rail: 'lightning',
      network: 'regtest',
      assetId: 'bitcoin:btc',
      amountAtomic,
      feeAtomic: '7',
      status: 'succeeded',
      paymentHash: createHash('sha256').update('payment-' + sourceId).digest('hex'),
      proofKind: 'payment_hash',
      proofReference: createHash('sha256').update('proof-' + sourceId).digest('hex'),
      settledAt: new Date('2026-07-17T12:00:00.000Z')
    }, session);
  });
  return receiptId;
}

try {
  await Promise.all([
    AuthSessionModel.syncIndexes(),
    RecipientIdentityModel.syncIndexes(),
    NotificationEndpointModel.syncIndexes(),
    PaymentReceiptModel.syncIndexes(),
    NotificationDeliveryModel.syncIndexes(),
    RateLimitBucketModel.syncIndexes()
  ]);
  await AuthSessionModel.create({
    tokenHash: createHash('sha256').update(token).digest('hex'),
    walletId: ownerWalletId,
    address: walletAddress,
    expiresAt: new Date(Date.now() + 60_000)
  });
  await RecipientIdentityModel.create({
    recipientId,
    ownerWalletId,
    name: 'Receipt recipient'
  });

  const receiptId = await addReceipt('event-no-endpoint');
  assert.equal(await queueReceiptNotifications(receiptId), 0);
  assert.equal((await PaymentReceiptModel.findOne({ receiptId }).lean())?.status, 'succeeded');

  const emailEndpoint = await request(app)
    .post('/v2/notification-endpoints')
    .set('Authorization', authorization)
    .send({ recipientId, type: 'email', value: 'receipts@example.com' })
    .expect(201);
  const nostrEndpoint = await request(app)
    .post('/v2/notification-endpoints')
    .set('Authorization', authorization)
    .send({ recipientId, type: 'nostr', value: '11'.repeat(32), relayUrls: ['ws://127.0.0.1:19876'] })
    .expect(201);
  assert.notEqual(emailEndpoint.body.unsubscribeToken, 'receipt-claim-token');
  assert.equal(emailEndpoint.body.endpoint.type, 'email');
  assert.equal(nostrEndpoint.body.endpoint.relayUrls.length, 1);
  assert.equal(await queueReceiptNotifications(receiptId), 2);

  const capturedEmails: Array<{ to: string; subject: string; text: string; html: string }> = [];
  const capturedNostr: Array<{ publicKey: string; relayUrls: string[]; message: string }> = [];
  let emailAttempts = 0;
  const flakyTransport: NotificationTransport = {
    async sendEmail(input) {
      emailAttempts += 1;
      capturedEmails.push(input);
      if (emailAttempts === 1) throw new Error('simulated SMTP outage containing receipts@example.com');
      return { reference: 'email-delivered' };
    },
    async sendNostr(input) {
      capturedNostr.push(input);
      return { reference: 'nostr-event-id' };
    }
  };
  const firstRunAt = new Date('2027-07-17T13:00:00.000Z');
  const firstRun = await runReceiptNotificationWorker({
    workerId: 'receipt-worker-1',
    limit: 2,
    now: firstRunAt,
    transport: flakyTransport
  });
  assert.deepEqual(firstRun, { claimed: 2, succeeded: 1, retried: 1, failed: 0, cancelled: 0 });
  const immutableAfterFailure = await PaymentReceiptModel.findOne({ receiptId }).lean<PaymentReceiptRecord | null>();
  assert.equal(immutableAfterFailure?.status, 'succeeded');
  assert.equal(immutableAfterFailure?.amountAtomic, '2500');

  const secondRun = await runReceiptNotificationWorker({
    workerId: 'receipt-worker-2',
    limit: 2,
    now: new Date(firstRunAt.getTime() + 10_000),
    transport: flakyTransport
  });
  assert.deepEqual(secondRun, { claimed: 1, succeeded: 1, retried: 0, failed: 0, cancelled: 0 });
  assert.equal(capturedEmails.length, 2);
  assert.equal(capturedNostr.length, 1);
  assert.equal(capturedEmails[1].to, 'receipts@example.com');
  assert.equal(capturedEmails[1].text.includes(ownerWalletId), false);
  assert.equal(capturedNostr[0].message.includes(ownerWalletId), false);
  assert.equal(await NotificationDeliveryModel.countDocuments({ receiptId, status: 'succeeded' }), 2);
  const rawDelivery = await NotificationDeliveryModel.collection.findOne({ receiptId });
  for (const forbidden of ['payload', 'content', 'message', 'value', 'token', 'invoice', 'preimage']) {
    assert.equal(rawDelivery?.[forbidden], undefined);
  }
  assert.equal(typeof rawDelivery?.lastFailureMessage, 'undefined');

  const originalHash = immutableAfterFailure?.receiptHash;
  await PaymentReceiptModel.updateOne({ receiptId }, { $set: { amountAtomic: '9999', status: 'failed' } }).catch(() => undefined);
  const afterMutationAttempt = await PaymentReceiptModel.findOne({ receiptId }).lean();
  assert.equal(afterMutationAttempt?.amountAtomic, '2500');
  assert.equal(afterMutationAttempt?.status, 'succeeded');
  assert.equal(afterMutationAttempt?.receiptHash, originalHash);

  const exported = await request(app)
    .get('/v2/receipts/export')
    .set('Authorization', authorization)
    .expect(200);
  assert.equal(exported.headers['content-disposition'], 'attachment; filename="fiberpass-receipts.json"');
  assert.equal(exported.body.receipts.length, 1);
  assert.equal(exported.body.deliveries.length, 2);

  const secondReceiptId = await addReceipt('event-unsubscribe', '3000');
  assert.equal(await queueReceiptNotifications(secondReceiptId), 2);
  const unsubscribe = await request(app)
    .post('/v2/notification-endpoints/unsubscribe')
    .send({ token: emailEndpoint.body.unsubscribeToken })
    .expect(200);
  assert.equal(unsubscribe.body.status, 'unsubscribed');
  assert.equal(unsubscribe.body.cancelledDeliveries, 1);
  assert.equal((await NotificationEndpointModel.findOne({ endpointId: emailEndpoint.body.endpoint.id }).lean())?.value, undefined);
  assert.equal(await NotificationDeliveryModel.countDocuments({ receiptId: secondReceiptId, channel: 'email', status: 'cancelled' }), 1);

  const deleteNostr = await request(app)
    .delete('/v2/notification-endpoints/' + nostrEndpoint.body.endpoint.id)
    .set('Authorization', authorization)
    .expect(200);
  assert.equal(deleteNostr.body.status, 'deleted');
  assert.equal(deleteNostr.body.cancelledDeliveries, 1);

  const retryEndpoint = await request(app)
    .post('/v2/notification-endpoints')
    .set('Authorization', authorization)
    .send({ recipientId, type: 'email', value: 'retry@example.com' })
    .expect(201);
  const thirdReceiptId = await addReceipt('event-terminal-failure', '4000');
  assert.equal(await queueReceiptNotifications(thirdReceiptId), 1);
  const failingTransport: NotificationTransport = {
    async sendEmail() { throw new Error('recipient and private invoice must not be persisted'); },
    async sendNostr() { throw new Error('unexpected Nostr delivery'); }
  };
  const retryStart = new Date('2027-07-18T00:00:00.000Z');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await runReceiptNotificationWorker({
      workerId: 'receipt-failure-' + attempt,
      limit: 1,
      now: new Date(retryStart.getTime() + attempt * 3_600_000),
      transport: failingTransport
    });
  }
  const terminalDelivery = await NotificationDeliveryModel.findOne({
    receiptId: thirdReceiptId,
    endpointId: retryEndpoint.body.endpoint.id
  }).lean();
  assert.equal(terminalDelivery?.status, 'failed');
  assert.equal(terminalDelivery?.attempts, 5);
  assert.equal(terminalDelivery?.lastFailureMessage, 'Delivery transport failed (Error).');
  assert.ok(terminalDelivery?.expiresAt);
  assert.equal(
    terminalDelivery?.expiresAt?.getTime(),
    retryStart.getTime() + 4 * 3_600_000 + 90 * 86_400_000
  );

  const deletion = await request(app)
    .delete('/v2/privacy/contact-data')
    .set('Authorization', authorization)
    .expect(200);
  assert.equal(deletion.body.paymentProofsPreserved, 3);
  assert.equal(await PaymentReceiptModel.countDocuments({ ownerWalletId }), 3);
  assert.equal(await NotificationEndpointModel.countDocuments({ ownerWalletId, value: { $exists: true } }), 0);
  assert.equal(await NotificationDeliveryModel.countDocuments({ ownerWalletId, status: { $in: ['queued', 'retrying', 'delivering'] } }), 0);
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
