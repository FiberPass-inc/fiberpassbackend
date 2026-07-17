import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import WebSocket, { type RawData } from 'ws';
import { wrapEvent as wrapNip17Event } from 'nostr-tools/nip17';
import type { Event } from 'nostr-tools/pure';
import { hexToBytes } from 'nostr-tools/utils';
import { env } from '../config/env.js';
import type { ContactChannelType } from '../domain/identity.js';
import { ApiError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import {
  NotificationEndpointModel,
  RecipientIdentityModel,
  type NotificationEndpointRecord
} from '../models/identity.model.js';
import {
  NotificationDeliveryModel,
  PaymentReceiptModel,
  type NotificationDeliveryRecord,
  type PaymentReceiptRecord
} from '../models/receipt.model.js';
import { sendEmail } from './email.service.js';
import { hashContactValue, newIdentityId } from './recipientIdentity.service.js';
import { paymentReceiptDto } from './receipt.service.js';
import { isForbiddenWebhookAddress } from './webhookSecurity.service.js';

const DELIVERY_LEASE_MS = 60_000;

export interface NotificationEndpointDto {
  id: string;
  recipientId: string;
  type: string;
  purpose: 'receipt';
  value?: string;
  relayUrls: string[];
  status: string;
  createdAt: string;
}

export interface NotificationTransport {
  sendEmail(input: { to: string; subject: string; text: string; html: string }): Promise<{ reference?: string } | void>;
  sendNostr(input: { publicKey: string; relayUrls: string[]; message: string }): Promise<{ reference?: string } | void>;
}

function endpointDto(endpoint: NotificationEndpointRecord & { createdAt?: Date }): NotificationEndpointDto {
  return {
    id: endpoint.endpointId,
    recipientId: endpoint.recipientId,
    type: endpoint.type,
    purpose: 'receipt',
    value: endpoint.value ?? undefined,
    relayUrls: [...(endpoint.relayUrls ?? [])],
    status: endpoint.status,
    createdAt: (endpoint.createdAt ?? new Date()).toISOString()
  };
}

function notificationTokenSecret(): string {
  const configured = env.NOTIFICATION_TOKEN_SECRET.trim();
  if (configured) return configured;
  if (env.NODE_ENV === 'production') throw new Error('Notification token secret is not configured.');
  return 'fiberpass-development-notification-token-secret';
}

export function createReceiptUnsubscribeToken(endpointId: string): string {
  const signature = createHmac('sha256', notificationTokenSecret())
    .update('receipt-unsubscribe:v1:' + endpointId)
    .digest('base64url');
  return endpointId + '.' + signature;
}

function validateReceiptUnsubscribeToken(token: string): string {
  const separator = token.lastIndexOf('.');
  if (separator < 1) throw new ApiError(400, 'UNSUBSCRIBE_TOKEN_INVALID', 'Unsubscribe token is invalid.');
  const endpointId = token.slice(0, separator);
  const supplied = Buffer.from(token.slice(separator + 1));
  const expected = Buffer.from(createReceiptUnsubscribeToken(endpointId).slice(separator + 1));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ApiError(400, 'UNSUBSCRIBE_TOKEN_INVALID', 'Unsubscribe token is invalid.');
  }
  return endpointId;
}

interface SafeRelay {
  url: string;
  addresses: Array<{ address: string; family: 4 | 6 }>;
}

async function resolveSafeRelay(value: string): Promise<SafeRelay> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(400, 'NOSTR_RELAY_INVALID', 'Nostr relay URL is invalid.');
  }
  const insecureLocal = env.NOSTR_NOTIFICATION_ALLOW_INSECURE_LOCAL_RELAY
    && url.protocol === 'ws:'
    && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !insecureLocal) {
    throw new ApiError(400, 'NOSTR_RELAY_SECURE_REQUIRED', 'Nostr receipt relays must use wss.');
  }
  if (url.username || url.password || url.hash) {
    throw new ApiError(400, 'NOSTR_RELAY_INVALID', 'Nostr relay URL cannot contain credentials or a fragment.');
  }
  const addressFamily = isIP(url.hostname);
  const addresses = addressFamily
    ? [{ address: url.hostname, family: addressFamily }]
    : await lookup(url.hostname, { all: true, verbatim: true }).catch(() => {
        throw new ApiError(503, 'NOSTR_RELAY_DNS_FAILED', 'Nostr relay hostname could not be resolved safely.');
      });
  if (addresses.length === 0) throw new ApiError(400, 'NOSTR_RELAY_UNREACHABLE', 'Nostr relay hostname did not resolve.');
  if (!insecureLocal) {
    if (addresses.some((entry) => isForbiddenWebhookAddress(entry.address))) {
      throw new ApiError(400, 'NOSTR_RELAY_FORBIDDEN', 'Nostr relay resolves to a private or reserved address.');
    }
  }
  return {
    url: url.toString(),
    addresses: addresses.map((entry) => ({ address: entry.address, family: entry.family as 4 | 6 }))
  };
}

async function assertSafeRelayUrl(value: string): Promise<string> {
  return (await resolveSafeRelay(value)).url;
}

function normalizeEndpointValue(type: ContactChannelType, value: string): string {
  const normalized = value.trim().toLowerCase();
  if (type === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 190) {
      throw new ApiError(400, 'NOTIFICATION_EMAIL_INVALID', 'Notification email address is invalid.');
    }
    return normalized;
  }
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new ApiError(400, 'NOTIFICATION_NOSTR_PUBKEY_INVALID', 'Nostr notification public key must be 32-byte lowercase hex.');
  }
  return normalized;
}

export async function createNotificationEndpoint(input: {
  recipientId: string;
  type: ContactChannelType;
  value: string;
  relayUrls?: string[];
}, ownerWalletId: string): Promise<{ endpoint: NotificationEndpointDto; unsubscribeToken: string }> {
  if (!await RecipientIdentityModel.exists({ recipientId: input.recipientId, ownerWalletId })) {
    throw new ApiError(404, 'NOTIFICATION_RECIPIENT_NOT_FOUND', 'Receipt recipient was not found for this wallet.');
  }
  const value = normalizeEndpointValue(input.type, input.value);
  const relayCandidates = [...new Set(input.relayUrls ?? [])];
  if (input.type === 'nostr' && (relayCandidates.length < 1 || relayCandidates.length > 3)) {
    throw new ApiError(400, 'NOSTR_INBOX_RELAYS_REQUIRED', 'NIP-17 receipt delivery requires one to three recipient inbox relays.');
  }
  if (input.type === 'email' && relayCandidates.length > 0) {
    throw new ApiError(400, 'NOTIFICATION_RELAYS_UNEXPECTED', 'Email notification endpoints cannot include Nostr relays.');
  }
  const relayUrls = input.type === 'nostr'
    ? await Promise.all(relayCandidates.map(assertSafeRelayUrl))
    : [];
  const valueHash = hashContactValue(value);
  const existing = await NotificationEndpointModel.findOne({
    ownerWalletId,
    recipientId: input.recipientId,
    type: input.type,
    purpose: 'receipt',
    valueHash,
    status: 'active'
  }).lean<NotificationEndpointRecord | null>();
  if (existing) {
    return { endpoint: endpointDto(existing), unsubscribeToken: createReceiptUnsubscribeToken(existing.endpointId) };
  }
  const endpointId = newIdentityId('ntf');
  const endpoint = await NotificationEndpointModel.create({
    endpointId,
    recipientId: input.recipientId,
    ownerWalletId,
    type: input.type,
    purpose: 'receipt',
    value,
    valueHash,
    relayUrls,
    status: 'active'
  });
  return {
    endpoint: endpointDto(endpoint.toObject()),
    unsubscribeToken: createReceiptUnsubscribeToken(endpointId)
  };
}

export async function listNotificationEndpoints(ownerWalletId: string): Promise<NotificationEndpointDto[]> {
  const endpoints = await NotificationEndpointModel.find({ ownerWalletId })
    .sort({ createdAt: 1 })
    .lean<NotificationEndpointRecord[]>();
  return endpoints.map(endpointDto);
}

async function cancelEndpointDeliveries(endpointId: string, now: Date): Promise<number> {
  const result = await NotificationDeliveryModel.updateMany(
    { endpointId, status: { $in: ['queued', 'retrying', 'delivering'] } },
    {
      $set: { status: 'cancelled', cancelledAt: now, leaseExpiresAt: now, expiresAt: terminalExpiry(now) },
      $unset: { leaseId: 1, lastFailureCode: 1, lastFailureMessage: 1 }
    }
  );
  return result.modifiedCount;
}

export async function removeNotificationEndpoint(endpointId: string, ownerWalletId: string, status: 'revoked' | 'deleted'): Promise<number> {
  const now = new Date();
  const endpoint = await NotificationEndpointModel.findOneAndUpdate(
    { endpointId, ownerWalletId, status: { $ne: 'deleted' } },
    {
      $set: {
        status,
        ...(status === 'revoked' ? { revokedAt: now } : { deletedAt: now })
      },
      $unset: { value: 1, valueHash: 1, relayUrls: 1, unsubscribeTokenHash: 1 }
    },
    { new: true }
  ).lean();
  if (!endpoint) throw new ApiError(404, 'NOTIFICATION_ENDPOINT_NOT_FOUND', 'Notification endpoint was not found.');
  return cancelEndpointDeliveries(endpointId, now);
}

export async function unsubscribeNotificationEndpoint(token: string): Promise<{ status: 'unsubscribed'; cancelledDeliveries: number }> {
  const endpointId = validateReceiptUnsubscribeToken(token.trim());
  const now = new Date();
  const endpoint = await NotificationEndpointModel.findOneAndUpdate(
    { endpointId, status: 'active' },
    {
      $set: { status: 'unsubscribed', unsubscribedAt: now },
      $unset: { value: 1, valueHash: 1, relayUrls: 1, unsubscribeTokenHash: 1 }
    },
    { new: true }
  ).lean();
  if (!endpoint) {
    const existing = await NotificationEndpointModel.exists({ endpointId, status: 'unsubscribed' });
    if (existing) return { status: 'unsubscribed', cancelledDeliveries: 0 };
    throw new ApiError(404, 'NOTIFICATION_ENDPOINT_NOT_FOUND', 'Notification endpoint was not found.');
  }
  return { status: 'unsubscribed', cancelledDeliveries: await cancelEndpointDeliveries(endpointId, now) };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character] ?? character));
}

function receiptSummary(receipt: PaymentReceiptRecord): string[] {
  const lines = [
    'Status: ' + receipt.status,
    'Amount: ' + receipt.amountAtomic + ' atomic units (' + receipt.assetId + ')',
    'Network: ' + receipt.rail + ' / ' + receipt.network,
    'Receipt: ' + receipt.receiptId,
    'Receipt hash: ' + receipt.receiptHash
  ];
  if (receipt.feeKnown) lines.splice(2, 0, 'Fee: ' + receipt.feeAtomic + ' atomic units');
  if (receipt.proofKind && receipt.proofReference) {
    lines.push('Network proof (' + receipt.proofKind + '): ' + receipt.proofReference);
  }
  return lines;
}

export function renderReceiptEmail(receipt: PaymentReceiptRecord, endpointId: string): {
  subject: string;
  text: string;
  html: string;
} {
  const lines = receiptSummary(receipt);
  const token = createReceiptUnsubscribeToken(endpointId);
  const unsubscribeUrl = env.PUBLIC_APP_URL.replace(/\/$/, '') + '/notifications/unsubscribe?token=' + encodeURIComponent(token);
  return {
    subject: 'FiberPass payment receipt ' + receipt.receiptId,
    text: ['FiberPass payment receipt', '', ...lines, '', 'Manage receipt notifications: ' + unsubscribeUrl].join('\n'),
    html: '<!doctype html><html><body><h1>FiberPass payment receipt</h1><dl>'
      + lines.map((line) => {
          const separator = line.indexOf(':');
          return '<dt>' + escapeHtml(line.slice(0, separator)) + '</dt><dd>' + escapeHtml(line.slice(separator + 1).trim()) + '</dd>';
        }).join('')
      + '</dl><p><a href="' + escapeHtml(unsubscribeUrl) + '">Manage receipt notifications</a></p></body></html>'
  };
}

export function renderReceiptNostrMessage(receipt: PaymentReceiptRecord): string {
  return ['FiberPass payment receipt', ...receiptSummary(receipt)].join('\n');
}

export function createNip17ReceiptEvent(input: {
  senderSecretKey: string;
  publicKey: string;
  relayUrl: string;
  message: string;
}) {
  const configuredKey = input.senderSecretKey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(configuredKey)) {
    throw new Error('Nostr notification sender key is not configured.');
  }
  return wrapNip17Event(
    hexToBytes(configuredKey),
    { publicKey: input.publicKey, relayUrl: input.relayUrl },
    input.message,
    'FiberPass receipt'
  );
}

function rawDataText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

async function publishNip17Event(relay: SafeRelay, event: Event): Promise<void> {
  return new Promise((resolve, reject) => {
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      const requestedFamily = typeof options.family === 'number' ? options.family : 0;
      const target = relay.addresses.find((entry) => !requestedFamily || entry.family === requestedFamily)
        ?? relay.addresses[0];
      callback(null, target.address, target.family);
    };
    const socket = new WebSocket(relay.url, {
      maxPayload: 64 * 1024,
      handshakeTimeout: env.NOTIFICATION_DELIVERY_TIMEOUT_MS,
      lookup: pinnedLookup
    });
    let finished = false;
    const finish = (error?: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (socket.readyState === WebSocket.OPEN) socket.close();
      else socket.terminate();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error('Nostr receipt delivery timed out.')),
      env.NOTIFICATION_DELIVERY_TIMEOUT_MS
    );
    socket.once('open', () => {
      socket.send(JSON.stringify(['EVENT', event]));
    });
    socket.on('message', (data) => {
      let message: unknown;
      try {
        message = JSON.parse(rawDataText(data));
      } catch {
        return;
      }
      if (!Array.isArray(message) || message[0] !== 'OK' || message[1] !== event.id) return;
      if (message[2] === true) finish();
      else finish(new Error('Nostr relay rejected the receipt event.'));
    });
    socket.once('error', () => finish(new Error('Nostr relay connection failed.')));
    socket.once('close', () => {
      if (!finished) finish(new Error('Nostr relay closed before acknowledging the receipt event.'));
    });
  });
}

async function publishNip17(input: { publicKey: string; relayUrls: string[]; message: string }): Promise<{ reference: string }> {
  const relays = await Promise.all(input.relayUrls.map(resolveSafeRelay));
  const event = createNip17ReceiptEvent({
    senderSecretKey: env.NOSTR_NOTIFICATION_SECRET_KEY,
    publicKey: input.publicKey,
    relayUrl: relays[0].url,
    message: input.message
  });

  await Promise.any(relays.map((relay) => publishNip17Event(relay, event)));
  return { reference: event.id };
}

export const productionNotificationTransport: NotificationTransport = {
  async sendEmail(input) {
    await sendEmail({
      ...input,
      headers: { 'X-FiberPass-Notification': 'payment-receipt' }
    });
  },
  async sendNostr(input) {
    return publishNip17(input);
  }
};

function terminalExpiry(now: Date): Date {
  return new Date(now.getTime() + env.NOTIFICATION_DELIVERY_RETENTION_DAYS * 86_400_000);
}

function publicDeliveryFailure(error: unknown): { code: string; message: string } {
  const name = error instanceof Error && /^[A-Za-z0-9_ -]{1,80}$/.test(error.name) ? error.name : 'Error';
  return { code: 'NOTIFICATION_DELIVERY_FAILED', message: 'Delivery transport failed (' + name + ').' };
}

async function claimNotificationDelivery(now: Date, workerId: string): Promise<NotificationDeliveryRecord | null> {
  return NotificationDeliveryModel.findOneAndUpdate(
    {
      status: { $in: ['queued', 'retrying', 'delivering'] },
      runAfter: { $lte: now },
      attempts: { $lt: 5 },
      $or: [{ leaseExpiresAt: { $lte: now } }, { leaseExpiresAt: { $exists: false } }]
    },
    {
      $set: {
        status: 'delivering',
        leaseId: workerId + ':' + randomUUID(),
        leaseExpiresAt: new Date(now.getTime() + DELIVERY_LEASE_MS)
      },
      $inc: { attempts: 1 }
    },
    { new: true, sort: { runAfter: 1, createdAt: 1 } }
  ).lean<NotificationDeliveryRecord | null>();
}

export async function runReceiptNotificationWorker(input: {
  workerId?: string;
  limit?: number;
  now?: Date;
  transport?: NotificationTransport;
} = {}): Promise<{ claimed: number; succeeded: number; retried: number; failed: number; cancelled: number }> {
  const now = input.now ?? new Date();
  const workerId = input.workerId ?? 'receipt-notification-worker';
  const transport = input.transport ?? productionNotificationTransport;
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
  const output = { claimed: 0, succeeded: 0, retried: 0, failed: 0, cancelled: 0 };
  for (let index = 0; index < limit; index += 1) {
    const delivery = await claimNotificationDelivery(now, workerId);
    if (!delivery) break;
    output.claimed += 1;
    const [endpoint, receipt] = await Promise.all([
      NotificationEndpointModel.findOne({ endpointId: delivery.endpointId }).lean<NotificationEndpointRecord | null>(),
      PaymentReceiptModel.findOne({ receiptId: delivery.receiptId }).lean<PaymentReceiptRecord | null>()
    ]);
    if (!endpoint || endpoint.status !== 'active' || !endpoint.value || !receipt) {
      await NotificationDeliveryModel.updateOne(
        { deliveryId: delivery.deliveryId, leaseId: delivery.leaseId },
        {
          $set: { status: 'cancelled', cancelledAt: now, leaseExpiresAt: now, expiresAt: terminalExpiry(now) },
          $unset: { leaseId: 1 }
        }
      );
      output.cancelled += 1;
      continue;
    }
    try {
      let result: { reference?: string } | void;
      if (endpoint.type === 'email') {
        result = await transport.sendEmail({ to: endpoint.value, ...renderReceiptEmail(receipt, endpoint.endpointId) });
      } else {
        result = await transport.sendNostr({
          publicKey: endpoint.value,
          relayUrls: [...(endpoint.relayUrls ?? [])],
          message: renderReceiptNostrMessage(receipt)
        });
      }
      await NotificationDeliveryModel.updateOne(
        { deliveryId: delivery.deliveryId, leaseId: delivery.leaseId },
        {
          $set: {
            status: 'succeeded',
            deliveredAt: now,
            leaseExpiresAt: now,
            expiresAt: terminalExpiry(now),
            ...(result?.reference ? { remoteReference: result.reference } : {})
          },
          $unset: { leaseId: 1, lastFailureCode: 1, lastFailureMessage: 1 }
        }
      );
      output.succeeded += 1;
    } catch (error) {
      const failure = publicDeliveryFailure(error);
      const terminal = delivery.attempts >= delivery.maxAttempts;
      const runAfter = new Date(now.getTime() + Math.min(3_600_000, 5_000 * (2 ** Math.min(delivery.attempts - 1, 10))));
      await NotificationDeliveryModel.updateOne(
        { deliveryId: delivery.deliveryId, leaseId: delivery.leaseId },
        {
          $set: {
            status: terminal ? 'failed' : 'retrying',
            lastFailureCode: failure.code,
            lastFailureMessage: failure.message,
            leaseExpiresAt: now,
            ...(terminal ? { failedAt: now, expiresAt: terminalExpiry(now) } : { runAfter })
          },
          $unset: { leaseId: 1 }
        }
      );
      if (terminal) output.failed += 1;
      else output.retried += 1;
      logger.warn('receipt_notification_delivery_failed', {
        deliveryId: delivery.deliveryId,
        receiptId: delivery.receiptId,
        channel: delivery.channel,
        terminal,
        failureCode: failure.code
      });
    }
  }
  return output;
}

export async function exportReceipts(ownerWalletId: string): Promise<{
  generatedAt: string;
  receipts: ReturnType<typeof paymentReceiptDto>[];
  deliveries: Array<{ receiptId: string; endpointId: string; channel: string; status: string; attempts: number; deliveredAt?: string }>;
}> {
  const [receipts, deliveries] = await Promise.all([
    PaymentReceiptModel.find({ ownerWalletId }).sort({ settledAt: 1 }).lean<PaymentReceiptRecord[]>(),
    NotificationDeliveryModel.find({ ownerWalletId }).sort({ createdAt: 1 }).lean<NotificationDeliveryRecord[]>()
  ]);
  return {
    generatedAt: new Date().toISOString(),
    receipts: receipts.map(paymentReceiptDto),
    deliveries: deliveries.map((delivery) => ({
      receiptId: delivery.receiptId,
      endpointId: delivery.endpointId,
      channel: delivery.channel,
      status: delivery.status,
      attempts: delivery.attempts,
      deliveredAt: delivery.deliveredAt?.toISOString()
    }))
  };
}
