import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { ApiError } from '../lib/errors.js';
import { isForbiddenWebhookAddress } from '../services/webhookSecurity.service.js';

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface ResolverTransport {
  requestJson(input: {
    url: string;
    method: 'GET' | 'POST';
    body?: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;
}

export interface DestinationResolverClientOptions {
  timeoutMs?: number;
  allowInsecureLocal?: boolean;
}

function localHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

export class DestinationResolverClient implements ResolverTransport {
  private readonly timeoutMs: number;
  private readonly allowInsecureLocal: boolean;

  constructor(options: DestinationResolverClientOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.allowInsecureLocal = options.allowInsecureLocal ?? false;
  }

  private async resolve(rawUrl: string): Promise<{ url: URL; addresses: Array<{ address: string; family: number }> }> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new ApiError(400, 'DESTINATION_RESOLVER_URL_INVALID', 'Payment resolver URL is invalid.');
    }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const local = localHostname(hostname);
    if (url.protocol !== 'https:' && !(this.allowInsecureLocal && local && url.protocol === 'http:')) {
      throw new ApiError(400, 'DESTINATION_RESOLVER_HTTPS_REQUIRED', 'Public payment resolvers must use HTTPS.');
    }
    if (url.username || url.password || url.hash) {
      throw new ApiError(400, 'DESTINATION_RESOLVER_URL_INVALID', 'Payment resolver URLs cannot contain credentials or fragments.');
    }
    if (!local && url.port && url.port !== '443') {
      throw new ApiError(400, 'DESTINATION_RESOLVER_PORT_FORBIDDEN', 'Public payment resolvers must use HTTPS port 443.');
    }
    const family = isIP(hostname);
    const addresses = family
      ? [{ address: hostname, family }]
      : await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
    if (addresses.length === 0) {
      throw new ApiError(400, 'DESTINATION_RESOLVER_DNS_FAILED', 'Payment resolver hostname did not resolve.');
    }
    if (!(this.allowInsecureLocal && local) && addresses.some((entry) => isForbiddenWebhookAddress(entry.address))) {
      throw new ApiError(400, 'DESTINATION_RESOLVER_ADDRESS_FORBIDDEN', 'Payment resolver points to a non-public network.');
    }
    return { url, addresses };
  }

  async assertUrl(rawUrl: string): Promise<string> {
    return (await this.resolve(rawUrl)).url.toString();
  }

  async requestJson(input: {
    url: string;
    method: 'GET' | 'POST';
    body?: Readonly<Record<string, unknown>>;
  }): Promise<unknown> {
    const resolved = await this.resolve(input.url);
    const payload = input.body == null ? undefined : Buffer.from(JSON.stringify(input.body), 'utf8');
    const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
      const family = typeof options.family === 'number' ? options.family : 0;
      const target = resolved.addresses.find((entry) => !family || entry.family === family) ?? resolved.addresses[0];
      callback(null, target.address, target.family);
    };

    return new Promise((resolve, reject) => {
      const requestFn = resolved.url.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = requestFn(resolved.url, {
        method: input.method,
        lookup: pinnedLookup,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'FiberPass-Scheduled-Payment-Resolver/1.0',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.byteLength } : {})
        }
      }, (response) => {
        const status = response.statusCode ?? 502;
        if (status >= 300 && status < 400) {
          request.destroy();
          reject(new ApiError(502, 'DESTINATION_RESOLVER_REDIRECT_FORBIDDEN', 'Payment resolver redirects are not followed.'));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy();
            reject(new ApiError(502, 'DESTINATION_RESOLVER_RESPONSE_TOO_LARGE', 'Payment resolver response exceeded the allowed size.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (status < 200 || status >= 300) {
            reject(new ApiError(502, 'DESTINATION_RESOLVER_REJECTED', 'Payment resolver rejected the request.'));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            reject(new ApiError(502, 'DESTINATION_RESOLVER_RESPONSE_INVALID', 'Payment resolver returned invalid JSON.'));
          }
        });
      });
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error('timeout')));
      request.once('error', () => reject(new ApiError(502, 'DESTINATION_RESOLVER_UNAVAILABLE', 'Payment resolver request failed or timed out.')));
      if (payload) request.write(payload);
      request.end();
    });
  }
}
