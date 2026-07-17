import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { ApiError } from '../lib/errors.js';
import { isForbiddenWebhookAddress } from '../services/webhookSecurity.service.js';

const MAX_RESPONSE_BYTES = 256 * 1024;

interface ResolvedServer {
  baseUrl: URL;
  addresses: Array<{ address: string; family: number }>;
}

export interface BtcpayResponse<T = unknown> {
  status: number;
  body: T;
}

export interface BtcpayGreenfieldClientOptions {
  timeoutMs?: number;
  allowInsecureLocal?: boolean;
}

function localHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export class BtcpayGreenfieldClient {
  private readonly timeoutMs: number;
  private readonly allowInsecureLocal: boolean;

  constructor(options: BtcpayGreenfieldClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.allowInsecureLocal = options.allowInsecureLocal ?? false;
  }

  private async resolveServer(raw: string): Promise<ResolvedServer> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new ApiError(400, 'BTCPAY_URL_INVALID', 'BTCPay server URL is invalid.');
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const local = localHostname(hostname);
    if (url.protocol !== 'https:' && !(this.allowInsecureLocal && local && url.protocol === 'http:')) {
      throw new ApiError(400, 'BTCPAY_HTTPS_REQUIRED', 'BTCPay server must use HTTPS.');
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
      throw new ApiError(400, 'BTCPAY_URL_INVALID', 'BTCPay server URL must be a credential-free origin.');
    }
    if (!local && url.port && url.port !== '443') {
      throw new ApiError(400, 'BTCPAY_PORT_FORBIDDEN', 'Public BTCPay servers must use HTTPS port 443.');
    }
    const family = isIP(hostname);
    const addresses = family
      ? [{ address: hostname, family }]
      : await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
    if (addresses.length === 0) throw new ApiError(400, 'BTCPAY_DNS_FAILED', 'BTCPay server hostname did not resolve.');
    if (!(this.allowInsecureLocal && local) && addresses.some((entry) => isForbiddenWebhookAddress(entry.address))) {
      throw new ApiError(400, 'BTCPAY_DESTINATION_FORBIDDEN', 'BTCPay server resolves to a non-public network.');
    }
    url.pathname = '/';
    return { baseUrl: url, addresses };
  }

  async request<T>(input: {
    serverUrl: string;
    apiKey: string;
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    body?: Record<string, unknown>;
  }): Promise<BtcpayResponse<T>> {
    if (!/^[A-Za-z0-9_-]{20,256}$/.test(input.apiKey)) throw new ApiError(400, 'BTCPAY_API_KEY_INVALID', 'BTCPay API key format is invalid.');
    if (!/^\/api\/v1\/[A-Za-z0-9_?=&%./-]+$/.test(input.path) || input.path.includes('..')) {
      throw new ApiError(500, 'BTCPAY_PATH_INVALID', 'BTCPay API path is invalid.');
    }
    const resolved = await this.resolveServer(input.serverUrl);
    const url = new URL(input.path, resolved.baseUrl);
    const payload = input.body == null ? undefined : Buffer.from(JSON.stringify(input.body), 'utf8');
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      const family = typeof options.family === 'number' ? options.family : 0;
      const target = resolved.addresses.find((entry) => !family || entry.family === family) ?? resolved.addresses[0];
      callback(null, target.address, target.family);
    };

    return new Promise((resolve, reject) => {
      const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = requestFn(url, {
        method: input.method,
        lookup: pinnedLookup,
        headers: {
          Accept: 'application/json',
          Authorization: 'token ' + input.apiKey,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.byteLength } : {})
        }
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy();
            reject(new ApiError(502, 'BTCPAY_RESPONSE_TOO_LARGE', 'BTCPay server response exceeded the allowed size.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          const status = response.statusCode ?? 502;
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = undefined;
          if (text) {
            try {
              body = JSON.parse(text);
            } catch {
              reject(new ApiError(502, 'BTCPAY_RESPONSE_INVALID', 'BTCPay server returned invalid JSON.'));
              return;
            }
          }
          resolve({ status, body: body as T });
        });
      });
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error('timeout')));
      request.once('error', () => reject(new ApiError(502, 'BTCPAY_UNAVAILABLE', 'BTCPay server request failed or timed out.')));
      if (payload) request.write(payload);
      request.end();
    });
  }
}
