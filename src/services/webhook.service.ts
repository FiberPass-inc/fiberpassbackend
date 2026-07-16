import { createHmac, randomUUID } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { AppModel, type AppRecord } from '../models/app.model.js';
import { WebhookDeliveryModel, type WebhookDeliveryRecord } from '../models/webhookDelivery.model.js';
import { writeAuditLog } from './audit.service.js';
import { decryptWebhookSecret, resolveWebhookDestination, type ResolvedWebhookDestination } from './webhookSecurity.service.js';

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

class WebhookDeliveryFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly responseStatus?: number
  ) {
    super(message);
  }
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
    .select('appId ownerWalletId webhookUrl webhookSigningSecretEncrypted')
    .lean<Pick<AppRecord, 'appId' | 'ownerWalletId' | 'webhookUrl' | 'webhookSigningSecretEncrypted'> | null>();

  if (!app?.webhookUrl || !app.webhookSigningSecretEncrypted) return;

  await WebhookDeliveryModel.create({
    deliveryId: newDeliveryId(),
    ownerWalletId: input.ownerWalletId,
    appId: input.appId,
    eventType: input.eventType,
    targetType: input.targetType,
    targetId: input.targetId,
    url: app.webhookUrl,
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
    {
      $set: { status: 'delivering', lockedAt: now, lockedBy: workerId },
      $inc: { attempts: 1 },
      $unset: { signingSecret: 1 }
    },
    { new: true, sort: { runAfter: 1, createdAt: 1 } }
  );
}

function postWebhook(input: {
  destination: ResolvedWebhookDestination;
  body: string;
  headers: Record<string, string>;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const { url, address, family } = input.destination;
    let timedOut = false;
    const request = httpsRequest({
      protocol: 'https:',
      hostname: address,
      family,
      port: 443,
      method: 'POST',
      path: url.pathname + url.search,
      servername: isIP(url.hostname) ? undefined : url.hostname,
      rejectUnauthorized: true,
      headers: {
        ...input.headers,
        host: url.host,
        'content-length': Buffer.byteLength(input.body).toString()
      }
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.setTimeout(env.WEBHOOK_DELIVERY_TIMEOUT_MS, () => {
      timedOut = true;
      request.destroy(new Error('Webhook request timed out.'));
    });
    request.on('error', (error) => {
      reject(new WebhookDeliveryFailure(
        timedOut ? 'WEBHOOK_TIMEOUT' : 'WEBHOOK_NETWORK_ERROR',
        error.message || 'Webhook network request failed.',
        true
      ));
    });
    request.end(input.body);
  });
}

export function webhookHttpFailure(status: number): WebhookDeliveryFailure | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status >= 300 && status < 400) {
    return new WebhookDeliveryFailure('WEBHOOK_REDIRECT_FORBIDDEN', 'Webhook redirects are not followed.', false, status);
  }
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  return new WebhookDeliveryFailure('WEBHOOK_HTTP_ERROR', 'Webhook endpoint returned HTTP ' + status + '.', retryable, status);
}

export async function deliverWebhook(delivery: WebhookDocument): Promise<'succeeded' | 'failed' | 'retried'> {
  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000).toString();

  try {
    const app = await AppModel.findOne({ appId: delivery.appId, ownerWalletId: delivery.ownerWalletId })
      .select('webhookSigningSecretEncrypted')
      .lean<Pick<AppRecord, 'webhookSigningSecretEncrypted'> | null>();
    if (!app?.webhookSigningSecretEncrypted) {
      throw new WebhookDeliveryFailure('WEBHOOK_SECRET_UNAVAILABLE', 'App webhook signing secret is not configured.', false);
    }
    const signingSecret = decryptWebhookSecret(app.webhookSigningSecretEncrypted);
    let destination: ResolvedWebhookDestination;
    try {
      destination = await resolveWebhookDestination(delivery.url);
    } catch (error) {
      if (error instanceof ApiError) {
        throw new WebhookDeliveryFailure(error.code, error.message, false);
      }
      throw error;
    }
    const responseStatus = await postWebhook({
      destination,
      body,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'FiberPass-Webhooks/1.0',
        'x-fiberpass-delivery': delivery.deliveryId,
        'x-fiberpass-event': delivery.eventType,
        'x-fiberpass-timestamp': timestamp,
        'x-fiberpass-signature': signWebhookPayload(signingSecret, timestamp, body)
      }
    });
    delivery.responseStatus = responseStatus;
    const httpFailure = webhookHttpFailure(responseStatus);
    if (httpFailure) throw httpFailure;

    delivery.status = 'succeeded';
    delivery.deliveredAt = new Date();
    delivery.lastFailureCode = undefined;
    delivery.lastFailureMessage = undefined;
    delivery.lockedAt = undefined;
    delivery.lockedBy = undefined;
    await delivery.save();
    await writeAuditLog({
      actorWalletId: delivery.ownerWalletId,
      action: 'webhook.delivered',
      targetType: 'webhook_delivery',
      targetId: delivery.deliveryId,
      metadata: { appId: delivery.appId, responseStatus }
    });
    return 'succeeded';
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Webhook delivery failed.';
    const failure = error instanceof WebhookDeliveryFailure
      ? error
      : new WebhookDeliveryFailure('WEBHOOK_DELIVERY_FAILED', message, true);
    const canRetry = failure.retryable && delivery.attempts < delivery.maxAttempts;
    delivery.lastFailureCode = failure.code;
    delivery.lastFailureMessage = message;
    if (failure.responseStatus != null) delivery.responseStatus = failure.responseStatus;
    delivery.lockedAt = undefined;
    delivery.lockedBy = undefined;

    if (canRetry) {
      delivery.status = 'retrying';
      delivery.runAfter = new Date(Date.now() + webhookBackoffMs(delivery.attempts));
      await delivery.save();
      await writeAuditLog({ actorWalletId: delivery.ownerWalletId, action: 'webhook.retry_scheduled', targetType: 'webhook_delivery', targetId: delivery.deliveryId, metadata: { appId: delivery.appId, failureCode: failure.code, attempts: delivery.attempts } });
      return 'retried';
    }

    delivery.status = 'failed';
    delivery.failedAt = new Date();
    await delivery.save();
    await writeAuditLog({ actorWalletId: delivery.ownerWalletId, action: 'webhook.failed', targetType: 'webhook_delivery', targetId: delivery.deliveryId, metadata: { appId: delivery.appId, failureCode: failure.code, attempts: delivery.attempts } });
    return 'failed';
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
