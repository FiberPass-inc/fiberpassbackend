import { createHmac, randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { AppModel, type AppRecord } from '../models/app.model.js';
import { WebhookDeliveryModel, type WebhookDeliveryRecord } from '../models/webhookDelivery.model.js';

type WebhookDocument = any;

export interface WebhookDeliveryDto {
  id: string;
  appId: string;
  eventType: string;
  targetType: string;
  targetId: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  deliveredAt?: string;
  failedAt?: string;
  responseStatus?: number;
  lastFailureCode?: string;
  lastFailureMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookWorkerRunResult {
  processed: number;
  succeeded: number;
  failed: number;
  retried: number;
}

function newDeliveryId(): string {
  return 'fp_wh_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

function toWebhookDeliveryDto(record: WebhookDeliveryRecord & { createdAt?: Date; updatedAt?: Date }): WebhookDeliveryDto {
  return {
    id: record.deliveryId,
    appId: record.appId,
    eventType: record.eventType,
    targetType: record.targetType,
    targetId: record.targetId,
    status: record.status,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    runAfter: record.runAfter.toISOString(),
    deliveredAt: record.deliveredAt?.toISOString(),
    failedAt: record.failedAt?.toISOString(),
    responseStatus: record.responseStatus ?? undefined,
    lastFailureCode: record.lastFailureCode ?? undefined,
    lastFailureMessage: record.lastFailureMessage ?? undefined,
    createdAt: (record.createdAt ?? new Date()).toISOString(),
    updatedAt: (record.updatedAt ?? record.createdAt ?? new Date()).toISOString()
  };
}

export function webhookBackoffMs(attempts: number): number {
  const safeAttempts = Number.isFinite(attempts) ? Math.max(1, Math.min(7, Math.floor(attempts))) : 1;
  return Math.min(120000, 2000 * (2 ** (safeAttempts - 1)));
}

export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(timestamp + '.' + body).digest('hex');
}

export async function enqueueWebhookEvent(input: {
  ownerWalletId: string;
  appId: string;
  eventType: string;
  targetType: string;
  targetId: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const app = await AppModel.findOne({ appId: input.appId, ownerWalletId: input.ownerWalletId })
    .select('appId ownerWalletId webhookUrl webhookSigningSecret')
    .lean<Pick<AppRecord, 'appId' | 'ownerWalletId' | 'webhookUrl' | 'webhookSigningSecret'> | null>();

  if (!app?.webhookUrl || !app.webhookSigningSecret) return;

  await WebhookDeliveryModel.create({
    deliveryId: newDeliveryId(),
    ownerWalletId: input.ownerWalletId,
    appId: input.appId,
    eventType: input.eventType,
    targetType: input.targetType,
    targetId: input.targetId,
    url: app.webhookUrl,
    signingSecret: app.webhookSigningSecret,
    payload: {
      id: input.targetId + ':' + input.eventType,
      event: input.eventType,
      appId: input.appId,
      createdAt: new Date().toISOString(),
      data: input.payload
    },
    status: 'queued',
    runAfter: new Date()
  });
}

export async function claimNextWebhookDelivery(workerId: string): Promise<WebhookDocument | null> {
  const now = new Date();
  return WebhookDeliveryModel.findOneAndUpdate(
    { status: { $in: ['queued', 'retrying'] }, runAfter: { $lte: now } },
    { $set: { status: 'delivering', lockedAt: now, lockedBy: workerId }, $inc: { attempts: 1 } },
    { new: true, sort: { runAfter: 1, createdAt: 1 } }
  );
}

async function deliverWebhook(delivery: WebhookDocument): Promise<'succeeded' | 'failed' | 'retried'> {
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.WEBHOOK_DELIVERY_TIMEOUT_MS);

  try {
    const response = await fetch(delivery.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'FiberPass-Webhooks/1.0',
        'x-fiberpass-delivery': delivery.deliveryId,
        'x-fiberpass-event': delivery.eventType,
        'x-fiberpass-timestamp': timestamp,
        'x-fiberpass-signature': signWebhookPayload(delivery.signingSecret, timestamp, body)
      },
      body,
      signal: controller.signal
    });

    delivery.responseStatus = response.status;
    if (response.ok) {
      delivery.status = 'succeeded';
      delivery.deliveredAt = new Date();
      delivery.lastFailureCode = undefined;
      delivery.lastFailureMessage = undefined;
      await delivery.save();
      return 'succeeded';
    }

    throw new Error('Webhook endpoint returned HTTP ' + response.status);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook delivery failed.';
    const canRetry = delivery.attempts < delivery.maxAttempts;
    delivery.lastFailureCode = error instanceof DOMException && error.name === 'AbortError' ? 'WEBHOOK_TIMEOUT' : 'WEBHOOK_DELIVERY_FAILED';
    delivery.lastFailureMessage = message;
    delivery.lockedAt = undefined;
    delivery.lockedBy = undefined;

    if (canRetry) {
      delivery.status = 'retrying';
      delivery.runAfter = new Date(Date.now() + webhookBackoffMs(delivery.attempts));
      await delivery.save();
      return 'retried';
    }

    delivery.status = 'failed';
    delivery.failedAt = new Date();
    await delivery.save();
    return 'failed';
  } finally {
    clearTimeout(timeout);
  }
}

export async function runWebhookWorkerOnce(options: { workerId?: string; limit?: number } = {}): Promise<WebhookWorkerRunResult> {
  const workerId = options.workerId?.trim() || 'fiberpass-webhook-worker';
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 10)));
  const result: WebhookWorkerRunResult = { processed: 0, succeeded: 0, failed: 0, retried: 0 };

  for (let index = 0; index < limit; index += 1) {
    const delivery = await claimNextWebhookDelivery(workerId);
    if (!delivery) break;

    const outcome = await deliverWebhook(delivery);
    result.processed += 1;
    result[outcome] += 1;
  }

  return result;
}

export async function listWebhookDeliveries(ownerWalletId: string, appId: string): Promise<{ deliveries: WebhookDeliveryDto[] }> {
  const deliveries = await WebhookDeliveryModel.find({ ownerWalletId, appId })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean<(WebhookDeliveryRecord & { createdAt?: Date; updatedAt?: Date })[]>();
  return { deliveries: deliveries.map(toWebhookDeliveryDto) };
}

export function logWebhookWorkerResult(workerId: string, result: WebhookWorkerRunResult): void {
  if (result.processed > 0) {
    logger.info('webhook_worker_batch_processed', { workerId, ...result });
  }
}
