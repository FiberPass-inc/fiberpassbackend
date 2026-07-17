import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import WebSocket, { type RawData } from 'ws';
import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools/pure';
import { encrypt as nip04Encrypt, decrypt as nip04Decrypt } from 'nostr-tools/nip04';
import { v2 as nip44 } from 'nostr-tools/nip44';
import {
  NWC_INFO_KIND,
  NWC_REQUEST_KIND,
  NWC_RESPONSE_KIND,
  type NwcEncryptionScheme
} from '../domain/nwc.js';
import { ApiError } from '../lib/errors.js';
import { isForbiddenWebhookAddress } from '../services/webhookSecurity.service.js';

const MAX_RELAY_MESSAGE_BYTES = 64 * 1024;

export interface NwcRequestPayload {
  method: string;
  params: Record<string, unknown>;
}

export interface NwcResponsePayload {
  result_type: string;
  error: { code: string; message: string } | null;
  result: Record<string, unknown> | null;
}

export interface NwcTransportRequest {
  relay: string;
  walletPubkey: string;
  clientPubkey: string;
  secret: Uint8Array;
  encryption: NwcEncryptionScheme;
  payload: NwcRequestPayload;
  timeoutMs?: number;
}

export interface NwcTransportResponse {
  requestEventId: string;
  responseEventId: string;
  response: NwcResponsePayload;
}

export class NwcRequestTimeoutError extends Error {
  constructor(public readonly requestEventId: string) {
    super('NWC wallet response timed out; payment outcome is unknown.');
  }
}

export interface NwcRelayTransportOptions {
  timeoutMs?: number;
  allowInsecureLocal?: boolean;
}

interface ValidatedRelay {
  url: string;
  addresses: Array<{ address: string; family: number }>;
}

function parseRelayMessage(data: RawData): unknown[] | undefined {
  const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8');
  if (Buffer.byteLength(text) > MAX_RELAY_MESSAGE_BYTES) return undefined;
  try {
    const message = JSON.parse(text);
    return Array.isArray(message) ? message : undefined;
  } catch {
    return undefined;
  }
}

function hasTag(event: Event, name: string, value: string): boolean {
  return event.tags.some((tag) => tag[0] === name && tag[1]?.toLowerCase() === value.toLowerCase());
}

function responsePayload(value: unknown, expectedMethod: string): NwcResponsePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(502, 'NWC_RESPONSE_INVALID', 'NWC wallet returned an invalid response.');
  }
  const input = value as Record<string, unknown>;
  if (input.result_type !== expectedMethod) {
    throw new ApiError(502, 'NWC_RESPONSE_METHOD_MISMATCH', 'NWC wallet response does not match the requested method.');
  }
  const error = input.error == null ? null : input.error;
  if (error !== null && (
    typeof error !== 'object'
    || Array.isArray(error)
    || typeof (error as Record<string, unknown>).code !== 'string'
    || typeof (error as Record<string, unknown>).message !== 'string'
  )) {
    throw new ApiError(502, 'NWC_RESPONSE_INVALID', 'NWC wallet returned an invalid error response.');
  }
  const result = input.result == null ? null : input.result;
  if (result !== null && (typeof result !== 'object' || Array.isArray(result))) {
    throw new ApiError(502, 'NWC_RESPONSE_INVALID', 'NWC wallet returned an invalid result response.');
  }
  return {
    result_type: input.result_type,
    error: error as NwcResponsePayload['error'],
    result: result as NwcResponsePayload['result']
  };
}

export class NwcRelayTransport {
  private readonly timeoutMs: number;
  private readonly allowInsecureLocal: boolean;

  constructor(options: NwcRelayTransportOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.allowInsecureLocal = options.allowInsecureLocal ?? false;
  }

  private async validateRelay(raw: string): Promise<ValidatedRelay> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ApiError(400, 'NWC_RELAY_INVALID', 'NWC relay URL is invalid.');
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    if (url.protocol !== 'wss:' && !(this.allowInsecureLocal && local && url.protocol === 'ws:')) {
      throw new ApiError(400, 'NWC_RELAY_TLS_REQUIRED', 'NWC relays must use secure WebSockets.');
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new ApiError(400, 'NWC_RELAY_INVALID', 'NWC relay URL cannot contain credentials or query data.');
    }
    const addressFamily = isIP(hostname);
    const addresses = addressFamily
      ? [{ address: hostname, family: addressFamily }]
      : await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
    if (addresses.length === 0) throw new ApiError(400, 'NWC_RELAY_UNREACHABLE', 'NWC relay hostname did not resolve.');
    if (!this.allowInsecureLocal || !local) {
      if (addresses.some((entry) => isForbiddenWebhookAddress(entry.address))) {
        throw new ApiError(400, 'NWC_RELAY_FORBIDDEN', 'NWC relay resolves to a non-public network.');
      }
    }
    return { url: url.toString(), addresses };
  }

  private async connect(relay: string, timeoutMs: number): Promise<WebSocket> {
    const safeRelay = await this.validateRelay(relay);
    return new Promise((resolve, reject) => {
      const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
        const requestedFamily = typeof options.family === 'number' ? options.family : 0;
        const target = safeRelay.addresses.find((entry) => !requestedFamily || entry.family === requestedFamily)
          ?? safeRelay.addresses[0];
        callback(null, target.address, target.family);
      };
      const socket = new WebSocket(safeRelay.url, {
        maxPayload: MAX_RELAY_MESSAGE_BYTES,
        handshakeTimeout: timeoutMs,
        lookup: pinnedLookup
      });
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new ApiError(504, 'NWC_RELAY_TIMEOUT', 'NWC relay connection timed out.'));
      }, timeoutMs);
      socket.once('open', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        reject(new ApiError(502, 'NWC_RELAY_UNAVAILABLE', 'NWC relay connection failed.'));
      });
    });
  }

  async fetchInfo(relays: readonly string[], walletPubkey: string, timeoutMs = this.timeoutMs): Promise<{ event: Event; relay: string }> {
    let lastError: unknown;
    for (const relay of relays) {
      try {
        const event = await this.fetchInfoFromRelay(relay, walletPubkey, timeoutMs);
        return { event, relay };
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError instanceof ApiError) throw lastError;
    throw new ApiError(502, 'NWC_INFO_UNAVAILABLE', 'NWC wallet info event could not be loaded.');
  }

  private async fetchInfoFromRelay(relay: string, walletPubkey: string, timeoutMs: number): Promise<Event> {
    const socket = await this.connect(relay, timeoutMs);
    return new Promise((resolve, reject) => {
      const subscriptionId = 'nwc-info-' + Math.random().toString(36).slice(2, 12);
      let latest: Event | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['CLOSE', subscriptionId]));
        socket.close();
      };
      const finish = () => {
        cleanup();
        if (latest) resolve(latest);
        else reject(new ApiError(404, 'NWC_INFO_NOT_FOUND', 'NWC wallet did not publish a capability event.'));
      };
      const timer = setTimeout(finish, timeoutMs);
      socket.on('message', (data) => {
        const message = parseRelayMessage(data);
        if (!message) return;
        if (message[0] === 'EVENT' && message[1] === subscriptionId) {
          const event = message[2] as Event;
          if (event?.kind === NWC_INFO_KIND && event.pubkey === walletPubkey && verifyEvent(event)) {
            if (!latest || event.created_at > latest.created_at) latest = event;
          }
        }
        if (message[0] === 'EOSE' && message[1] === subscriptionId) finish();
      });
      socket.once('close', () => {
        if (!latest) {
          cleanup();
          reject(new ApiError(502, 'NWC_RELAY_CLOSED', 'NWC relay closed before returning wallet info.'));
        }
      });
      socket.send(JSON.stringify(['REQ', subscriptionId, { kinds: [NWC_INFO_KIND], authors: [walletPubkey], limit: 5 }]));
    });
  }

  async request(input: NwcTransportRequest): Promise<NwcTransportResponse> {
    const timeoutMs = input.timeoutMs ?? this.timeoutMs;
    const plaintext = JSON.stringify(input.payload);
    const content = input.encryption === 'nip44_v2'
      ? nip44.encrypt(plaintext, nip44.utils.getConversationKey(input.secret, input.walletPubkey))
      : await nip04Encrypt(input.secret, input.walletPubkey, plaintext);
    const expiration = Math.floor((Date.now() + timeoutMs + 5_000) / 1000).toString();
    const event = finalizeEvent({
      kind: NWC_REQUEST_KIND,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['p', input.walletPubkey],
        ['expiration', expiration],
        ['encryption', input.encryption]
      ],
      content
    }, input.secret);
    const socket = await this.connect(input.relay, timeoutMs);

    return new Promise((resolve, reject) => {
      const subscriptionId = 'nwc-response-' + event.id.slice(0, 12);
      let finished = false;
      const cleanup = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(['CLOSE', subscriptionId]));
        socket.close();
      };
      const fail = (error: unknown) => {
        cleanup();
        reject(error);
      };
      const timer = setTimeout(() => fail(new NwcRequestTimeoutError(event.id)), timeoutMs);
      socket.on('message', async (data) => {
        const message = parseRelayMessage(data);
        if (!message || message[0] !== 'EVENT' || message[1] !== subscriptionId) return;
        const responseEvent = message[2] as Event;
        if (
          responseEvent?.kind !== NWC_RESPONSE_KIND
          || responseEvent.pubkey !== input.walletPubkey
          || !verifyEvent(responseEvent)
          || !hasTag(responseEvent, 'p', input.clientPubkey)
          || !hasTag(responseEvent, 'e', event.id)
        ) return;
        try {
          const decrypted = input.encryption === 'nip44_v2'
            ? nip44.decrypt(responseEvent.content, nip44.utils.getConversationKey(input.secret, input.walletPubkey))
            : await nip04Decrypt(input.secret, input.walletPubkey, responseEvent.content);
          if (Buffer.byteLength(decrypted) > MAX_RELAY_MESSAGE_BYTES) throw new Error('response too large');
          const response = responsePayload(JSON.parse(decrypted), input.payload.method);
          cleanup();
          resolve({ requestEventId: event.id, responseEventId: responseEvent.id, response });
        } catch (error) {
          fail(error instanceof ApiError ? error : new ApiError(502, 'NWC_RESPONSE_INVALID', 'NWC wallet response could not be verified.'));
        }
      });
      socket.once('close', () => {
        if (!finished) fail(new NwcRequestTimeoutError(event.id));
      });
      socket.send(JSON.stringify([
        'REQ',
        subscriptionId,
        { kinds: [NWC_RESPONSE_KIND], authors: [input.walletPubkey], '#p': [input.clientPubkey], '#e': [event.id], since: event.created_at - 5 }
      ]));
      socket.send(JSON.stringify(['EVENT', event]));
    });
  }
}
