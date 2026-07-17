import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';

const MAX_RPC_RESPONSE_BYTES = 512 * 1024;

interface RpcEnvelope<T> {
  result: T;
  error: { code?: number; message?: string } | null;
  id: string;
}

export interface BitcoinCoreClientOptions {
  rpcUrl?: string;
  username?: string;
  password?: string;
  timeoutMs?: number;
}

export interface CoreTxOut {
  bestblock: string;
  confirmations: number;
  value: number | string;
  scriptPubKey: { hex: string; type?: string; address?: string };
  coinbase: boolean;
}

export class BitcoinCoreClient {
  private readonly rpcUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;

  constructor(options: BitcoinCoreClientOptions = {}) {
    this.rpcUrl = options.rpcUrl ?? env.BITCOIN_CORE_RPC_URL;
    this.username = options.username ?? env.BITCOIN_CORE_RPC_USER;
    this.password = options.password ?? env.BITCOIN_CORE_RPC_PASSWORD;
    this.timeoutMs = options.timeoutMs ?? env.BITCOIN_CORE_RPC_TIMEOUT_MS;
  }

  private async call<T>(method: string, params: unknown[] = []): Promise<T> {
    let url: URL;
    try {
      url = new URL(this.rpcUrl);
    } catch {
      throw new ApiError(503, 'BITCOIN_CORE_NOT_CONFIGURED', 'Bitcoin Core RPC is not configured.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new ApiError(503, 'BITCOIN_CORE_CONFIG_INVALID', 'Bitcoin Core RPC configuration is invalid.');
    }
    if (!/^[a-z][a-z0-9_]{1,63}$/.test(method)) throw new ApiError(500, 'BITCOIN_CORE_METHOD_INVALID', 'Bitcoin Core RPC method is invalid.');
    const id = randomUUID();
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    const authorization = Buffer.from(this.username + ':' + this.password, 'utf8').toString('base64');

    return new Promise((resolve, reject) => {
      const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = requestFn(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Content-Length': payload.byteLength,
          ...(this.username || this.password ? { Authorization: 'Basic ' + authorization } : {})
        }
      }, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size > MAX_RPC_RESPONSE_BYTES) {
            request.destroy();
            reject(new ApiError(502, 'BITCOIN_CORE_RESPONSE_TOO_LARGE', 'Bitcoin Core RPC response exceeded the allowed size.'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as RpcEnvelope<T>;
            if (parsed.id !== id || parsed.error) {
              reject(new ApiError(502, 'BITCOIN_CORE_RPC_FAILED', 'Bitcoin Core rejected the requested operation.', {
                rpcCode: parsed.error?.code
              }));
              return;
            }
            resolve(parsed.result);
          } catch (error) {
            reject(error instanceof ApiError ? error : new ApiError(502, 'BITCOIN_CORE_RESPONSE_INVALID', 'Bitcoin Core RPC returned invalid JSON.'));
          }
        });
      });
      request.setTimeout(this.timeoutMs, () => request.destroy(new Error('timeout')));
      request.once('error', () => reject(new ApiError(502, 'BITCOIN_CORE_UNAVAILABLE', 'Bitcoin Core RPC request failed or timed out.')));
      request.write(payload);
      request.end();
    });
  }

  getBlockchainInfo(): Promise<{ chain: string; blocks: number; headers: number; initialblockdownload: boolean }> {
    return this.call('getblockchaininfo');
  }

  getTxOut(txid: string, vout: number): Promise<CoreTxOut | null> {
    return this.call('gettxout', [txid, vout, true]);
  }

  finalizePsbt(psbt: string): Promise<{ psbt?: string; hex?: string; complete: boolean }> {
    return this.call('finalizepsbt', [psbt, true]);
  }

  decodeRawTransaction(hex: string): Promise<Record<string, unknown>> {
    return this.call('decoderawtransaction', [hex]);
  }

  testMempoolAccept(hex: string, maxFeeRateBtcKvB: string): Promise<Array<{ txid: string; allowed: boolean; 'reject-reason'?: string }>> {
    return this.call('testmempoolaccept', [[hex], maxFeeRateBtcKvB]);
  }

  sendRawTransaction(hex: string, maxFeeRateBtcKvB: string): Promise<string> {
    return this.call('sendrawtransaction', [hex, maxFeeRateBtcKvB]);
  }

  getRawTransaction(txid: string): Promise<{ txid: string; hash: string; confirmations?: number; blockhash?: string }> {
    return this.call('getrawtransaction', [txid, true]);
  }

  getMempoolEntry(txid: string): Promise<{ vsize: number; fees: { base: number | string }; 'bip125-replaceable': boolean }> {
    return this.call('getmempoolentry', [txid]);
  }
}

export const bitcoinCoreClient = new BitcoinCoreClient();
