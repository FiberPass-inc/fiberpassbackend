import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { AppModel } from '../models/app.model.js';
import { AuditLogModel } from '../models/auditLog.model.js';
import { DomainEventModel } from '../models/domainEvent.model.js';
import { WebhookDeliveryModel } from '../models/webhookDelivery.model.js';
import { WorkerHeartbeatModel } from '../models/workerHeartbeat.model.js';
import { WorkerLeaseModel } from '../models/workerLease.model.js';
import { liveEvents } from '../lib/liveEvents.js';
import { runReconciliationWorkerOnce } from '../services/reconciliation.service.js';
import { claimNextWebhookDelivery, enqueueWebhookEvent } from '../services/webhook.service.js';
import { encryptWebhookSecret } from '../services/webhookSecurity.service.js';
import { acquireWorkerLease, getWorkerReadiness, recordWorkerHeartbeat, releaseWorkerLease } from '../services/workerRuntime.service.js';

const uri = process.env.WORKER_TEST_MONGODB_URI;
if (!uri) throw new Error('WORKER_TEST_MONGODB_URI is required for worker integration tests.');

process.env.FIBERPASS_VAULT_CODE_HASH = '';
process.env.FIBERPASS_OPERATOR_LOCK_HASH = '';

const dbName = 'fiberpass_worker_reliability_' + randomUUID().replace(/-/g, '');
await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 10_000 });

function webhookRecord(deliveryId: string, status: 'queued' | 'delivering', lockedAt?: Date) {
  return {
    deliveryId,
    ownerWalletId: 'worker-owner',
    appId: 'worker-app',
    eventType: 'invoice.paid',
    targetType: 'invoice',
    targetId: 'invoice-1',
    url: 'https://example.com/webhook',
    payload: { ok: true },
    status,
    attempts: status === 'delivering' ? 1 : 0,
    maxAttempts: 5,
    runAfter: new Date(0),
    lockedAt,
    lockedBy: lockedAt ? 'crashed-worker' : undefined
  };
}

try {
  await Promise.all([
    DomainEventModel.syncIndexes(),
    AppModel.syncIndexes(),
    AuditLogModel.syncIndexes(),
    WebhookDeliveryModel.syncIndexes(),
    WorkerHeartbeatModel.syncIndexes(),
    WorkerLeaseModel.syncIndexes()
  ]);

  const eventName = 'overview:worker-test';
  const first = await DomainEventModel.create({ eventName, payload: { version: 1 }, expiresAt: new Date(Date.now() + 60_000) });
  await DomainEventModel.create({ eventName, payload: { version: 2 }, expiresAt: new Date(Date.now() + 60_000) });
  const replay = await liveEvents.readAfter(eventName, first._id.toString());
  assert.deepEqual(replay.map((event) => event.payload), [{ version: 2 }]);

  await AppModel.create({
    appId: 'worker-app',
    ownerWalletId: 'worker-owner',
    name: 'Webhook integration app',
    serviceAddress: 'ckt1-worker',
    webhookUrl: 'https://example.com/webhook',
    webhookSecretHash: 'test-hash',
    webhookSigningSecretEncrypted: encryptWebhookSecret('worker-secret', '11'.repeat(32)),
    status: 'active'
  });
  await enqueueWebhookEvent({
    ownerWalletId: 'worker-owner',
    appId: 'worker-app',
    eventType: 'integration.enqueued',
    targetType: 'invoice',
    targetId: 'invoice-enqueued',
    payload: { ok: true }
  });
  const enqueuedRaw = await WebhookDeliveryModel.collection.findOne({ eventType: 'integration.enqueued' });
  assert.ok(enqueuedRaw);
  assert.equal(Object.prototype.hasOwnProperty.call(enqueuedRaw, 'signingSecret'), false);
  await WebhookDeliveryModel.updateOne({ eventType: 'integration.enqueued' }, { $set: { status: 'succeeded' } });

  const leaseResults = await Promise.all(
    Array.from({ length: 20 }, (_, index) => acquireWorkerLease({
      leaseKey: 'reconciliation:test',
      ownerId: 'worker-' + index,
      ttlMs: 60_000
    }))
  );
  assert.equal(leaseResults.filter(Boolean).length, 1);
  const winner = 'worker-' + leaseResults.findIndex(Boolean);
  await releaseWorkerLease('reconciliation:test', winner);
  assert.equal(await acquireWorkerLease({ leaseKey: 'reconciliation:test', ownerId: 'recovery-worker', ttlMs: 60_000 }), true);

  await WebhookDeliveryModel.create(webhookRecord('delivery-contention', 'queued'));
  const claims = await Promise.all(
    Array.from({ length: 20 }, (_, index) => claimNextWebhookDelivery('webhook-worker-' + index))
  );
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal((await WebhookDeliveryModel.findOne({ deliveryId: 'delivery-contention' }).lean())?.attempts, 1);

  await WebhookDeliveryModel.create(webhookRecord('delivery-stale', 'delivering', new Date(Date.now() - 120_000)));
  const recovery = await Promise.all([
    runReconciliationWorkerOnce({ limit: 10, staleWebhookMs: 30_000 }),
    runReconciliationWorkerOnce({ limit: 10, staleWebhookMs: 30_000 })
  ]);
  assert.equal(recovery.reduce((total, result) => total + result.webhooksRequeued, 0), 1);
  assert.equal((await WebhookDeliveryModel.findOne({ deliveryId: 'delivery-stale' }).lean())?.status, 'retrying');
  assert.equal(await AuditLogModel.countDocuments({ action: 'reconciliation.webhook_requeued', targetId: 'delivery-stale' }), 1);

  await Promise.all([
    recordWorkerHeartbeat({ workerId: 'payments-1', kind: 'payments', success: true }),
    recordWorkerHeartbeat({ workerId: 'reconciliation-1', kind: 'reconciliation', success: true }),
    recordWorkerHeartbeat({ workerId: 'webhooks-1', kind: 'webhooks', success: true })
  ]);
  assert.equal((await getWorkerReadiness(30_000)).ready, true);
  await WorkerHeartbeatModel.updateOne({ workerId: 'webhooks-1' }, { $set: { lastSeenAt: new Date(Date.now() - 60_000) } });
  assert.equal((await getWorkerReadiness(30_000)).ready, false);
} finally {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
