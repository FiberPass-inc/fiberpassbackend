import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';

export type FiberProviderKind = 'mock' | 'rpc';
export type FiberSessionStatus = 'pending' | 'active' | 'paused' | 'closing' | 'settled' | 'revoked' | 'expired' | 'failed';
export type FiberSettlementReason = 'revoked' | 'settled' | 'expired';

export interface FiberMoneyInput {
  amountMinor: number;
  currency: string;
}

export interface FiberCreateSessionInput extends FiberMoneyInput {
  localSessionId: string;
  walletId: string;
  appAddress: string;
  expiresAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface FiberCreateSessionResult {
  provider: FiberProviderKind;
  network: string;
  networkSessionId: string;
  status: FiberSessionStatus;
  proofId?: string;
  raw?: unknown;
}

export interface FiberAuthorizeChargeInput extends FiberMoneyInput {
  sessionId: string;
  networkSessionId?: string;
  appAddress: string;
  paymentRequest?: string;
  metadata?: Record<string, unknown>;
}

export interface FiberChargeResult {
  provider: FiberProviderKind;
  network: string;
  authorized: true;
  proofId: string;
  raw?: unknown;
}

export interface FiberTopUpInput extends FiberMoneyInput {
  sessionId: string;
  networkSessionId?: string;
  walletId: string;
}

export interface FiberTopUpResult {
  provider: FiberProviderKind;
  network: string;
  proofId: string;
  raw?: unknown;
}

export interface FiberSettleInput extends FiberMoneyInput {
  sessionId: string;
  networkSessionId?: string;
  reason: FiberSettlementReason;
}

export interface FiberSettleResult {
  provider: FiberProviderKind;
  network: string;
  settled: true;
  proofId: string;
  raw?: unknown;
}

export interface FiberStatusResult {
  provider: FiberProviderKind;
  network: string;
  status: FiberSessionStatus;
  networkSessionId?: string;
  raw?: unknown;
}

export interface FiberProvider {
  readonly kind: FiberProviderKind;
  readonly network: string;
  createSession(input: FiberCreateSessionInput): Promise<FiberCreateSessionResult>;
  authorizeCharge(input: FiberAuthorizeChargeInput): Promise<FiberChargeResult>;
  topUpSession(input: FiberTopUpInput): Promise<FiberTopUpResult>;
  revokeSession(input: FiberSettleInput): Promise<FiberSettleResult>;
  settleSession(input: FiberSettleInput): Promise<FiberSettleResult>;
  getStatus(sessionId: string, networkSessionId?: string): Promise<FiberStatusResult>;
}

interface MockSessionState {
  networkSessionId: string;
  status: FiberSessionStatus;
  allocatedMinor: number;
  spentMinor: number;
  currency: string;
}

export class MockFiberProvider implements FiberProvider {
  readonly kind = 'mock' as const;
  readonly network: string;
  private sessions = new Map<string, MockSessionState>();

  constructor(network = env.FIBER_NETWORK) {
    this.network = network;
  }

  async createSession(input: FiberCreateSessionInput): Promise<FiberCreateSessionResult> {
    const networkSessionId = 'mock_fiber_' + randomUUID().replace(/-/g, '').slice(0, 20);
    this.sessions.set(input.localSessionId, {
      networkSessionId,
      status: 'active',
      allocatedMinor: input.amountMinor,
      spentMinor: 0,
      currency: input.currency
    });

    return {
      provider: this.kind,
      network: this.network,
      networkSessionId,
      status: 'active',
      proofId: 'mock_open_' + randomUUID().replace(/-/g, '').slice(0, 16)
    };
  }

  async authorizeCharge(input: FiberAuthorizeChargeInput): Promise<FiberChargeResult> {
    const state = this.sessions.get(input.sessionId);
    if (state && state.status !== 'active') {
      throw new Error('Mock Fiber session is not active.');
    }
    if (state && state.spentMinor + input.amountMinor > state.allocatedMinor) {
      throw new Error('Mock Fiber session balance exceeded.');
    }
    if (state) state.spentMinor += input.amountMinor;

    return {
      provider: this.kind,
      network: this.network,
      authorized: true,
      proofId: 'mock_charge_' + randomUUID().replace(/-/g, '').slice(0, 16)
    };
  }

  async topUpSession(input: FiberTopUpInput): Promise<FiberTopUpResult> {
    const state = this.sessions.get(input.sessionId);
    if (state) state.allocatedMinor += input.amountMinor;

    return {
      provider: this.kind,
      network: this.network,
      proofId: 'mock_topup_' + randomUUID().replace(/-/g, '').slice(0, 16)
    };
  }

  async revokeSession(input: FiberSettleInput): Promise<FiberSettleResult> {
    const state = this.sessions.get(input.sessionId);
    if (state) state.status = 'revoked';
    return this.settledResult('mock_revoke_');
  }

  async settleSession(input: FiberSettleInput): Promise<FiberSettleResult> {
    const state = this.sessions.get(input.sessionId);
    if (state) state.status = input.reason === 'expired' ? 'expired' : 'settled';
    return this.settledResult('mock_settle_');
  }

  async getStatus(sessionId: string, networkSessionId?: string): Promise<FiberStatusResult> {
    const state = this.sessions.get(sessionId);
    return {
      provider: this.kind,
      network: this.network,
      status: state?.status ?? 'pending',
      networkSessionId: state?.networkSessionId ?? networkSessionId
    };
  }

  private settledResult(prefix: string): FiberSettleResult {
    return {
      provider: this.kind,
      network: this.network,
      settled: true,
      proofId: prefix + randomUUID().replace(/-/g, '').slice(0, 16)
    };
  }
}

export class RpcFiberProvider implements FiberProvider {
  readonly kind = 'rpc' as const;
  readonly network: string;
  private readonly rpcUrl: string;
  private nextId = 1;

  constructor(input: { rpcUrl: string; network?: string }) {
    this.rpcUrl = input.rpcUrl;
    this.network = input.network ?? env.FIBER_NETWORK;
  }

  async createSession(input: FiberCreateSessionInput): Promise<FiberCreateSessionResult> {
    const channelPeerId = typeof input.metadata?.fiberPeerId === 'string' ? input.metadata.fiberPeerId : env.FIBER_PEER_ID;
    if (!channelPeerId) {
      throw new Error('FIBER_PEER_ID is required to open a real Fiber channel.');
    }

    const raw = await this.rpc('open_channel', [{
      peer_id: channelPeerId,
      funding_amount: input.amountMinor.toString(),
      public: false,
      shutdown_script: typeof input.metadata?.shutdownScript === 'string' ? input.metadata.shutdownScript : undefined
    }]);

    return {
      provider: this.kind,
      network: this.network,
      networkSessionId: String((raw as { channel_id?: unknown })?.channel_id ?? input.localSessionId),
      status: 'pending',
      proofId: String((raw as { tx_hash?: unknown })?.tx_hash ?? ''),
      raw
    };
  }

  async authorizeCharge(input: FiberAuthorizeChargeInput): Promise<FiberChargeResult> {
    const invoice = input.paymentRequest ?? (typeof input.metadata?.fiberInvoice === 'string' ? input.metadata.fiberInvoice : '');
    if (!invoice) {
      throw new Error('A Fiber invoice/payment request is required for real Fiber charges.');
    }

    const raw = await this.rpc('send_payment', [{ invoice }]);
    return {
      provider: this.kind,
      network: this.network,
      authorized: true,
      proofId: String((raw as { payment_hash?: unknown })?.payment_hash ?? (raw as { hash?: unknown })?.hash ?? ''),
      raw
    };
  }

  async topUpSession(input: FiberTopUpInput): Promise<FiberTopUpResult> {
    if (!input.networkSessionId) {
      throw new Error('networkSessionId is required to top up a real Fiber session.');
    }
    const raw = await this.rpc('add_tlc', [{
      channel_id: input.networkSessionId,
      amount: input.amountMinor.toString()
    }]);
    return { provider: this.kind, network: this.network, proofId: String((raw as { id?: unknown })?.id ?? ''), raw };
  }

  async revokeSession(input: FiberSettleInput): Promise<FiberSettleResult> {
    return this.shutdown(input, 'revoked');
  }

  async settleSession(input: FiberSettleInput): Promise<FiberSettleResult> {
    return this.shutdown(input, input.reason);
  }

  async getStatus(sessionId: string, networkSessionId?: string): Promise<FiberStatusResult> {
    const raw = networkSessionId
      ? await this.rpc('channel', [{ channel_id: networkSessionId }])
      : await this.rpc('node_info', []);
    return {
      provider: this.kind,
      network: this.network,
      status: networkSessionId ? 'active' : 'pending',
      networkSessionId: networkSessionId ?? sessionId,
      raw
    };
  }

  private async shutdown(input: FiberSettleInput, reason: FiberSettlementReason): Promise<FiberSettleResult> {
    if (!input.networkSessionId) {
      throw new Error('networkSessionId is required to close a real Fiber session.');
    }
    const raw = await this.rpc('shutdown_channel', [{ channel_id: input.networkSessionId, force: reason === 'revoked' }]);
    return {
      provider: this.kind,
      network: this.network,
      settled: true,
      proofId: String((raw as { tx_hash?: unknown })?.tx_hash ?? ''),
      raw
    };
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await fetch(this.rpcUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.FIBER_API_KEY ? { Authorization: 'Bearer ' + env.FIBER_API_KEY } : {})
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params })
    });

    const payload = await response.json() as { result?: unknown; error?: { code?: number; message?: string } };
    if (!response.ok || payload.error) {
      throw new Error(payload.error?.message ?? 'Fiber RPC request failed: ' + method);
    }
    return payload.result;
  }
}

export function createFiberProvider(): FiberProvider {
  if (env.FIBER_PROVIDER === 'rpc') {
    return new RpcFiberProvider({ rpcUrl: env.FIBER_RPC_URL, network: env.FIBER_NETWORK });
  }
  return new MockFiberProvider(env.FIBER_NETWORK);
}

export const fiberProvider = createFiberProvider();
