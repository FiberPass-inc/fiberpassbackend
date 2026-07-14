import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { fromMinorUnits, toMinorUnits } from '../lib/money.js';
import { SessionModel } from '../models/session.model.js';
import { writeAuditLog } from './audit.service.js';
import { getCkbTransaction, listLiveVaultCells, parseCkbAddress } from './ckbChain.service.js';
import { openFiberTestChannel } from './fiberChannel.service.js';
import { getFiberNodeReadiness } from './fiberNode.service.js';
import { executeVaultLiquidityBridge } from './vaultPayout.service.js';

export interface FiberLiquidityBridgeInput {
  ownerWalletId: string;
  sessionId: string;
  recipientIndex: number;
  amountMinor: number;
  currency: string;
}

export interface FiberLiquidityBridgeReadyResult {
  ready: true;
  outboundCapacityMinor?: number;
}

export interface FiberPayoutLiquiditySnapshot {
  channelCount: number;
  totalOutboundCapacityMinor?: number;
  maxOutboundCapacityMinor?: number;
}

type RecipientBridgeState = {
  fiberLiquidityBridgeTxHash?: string;
  fiberLiquidityBridgeAmountMinor?: number;
  fiberLiquidityBridgeStatus?: string;
  fiberLiquidityBridgeCreatedAt?: Date | string;
  fiberChannelOpenProofId?: string;
  fiberChannelOpenAmountMinor?: number;
  fiberChannelOpenRequestedAt?: Date | string;
  fiberLiquidityBridgeTopUpTxHash?: string;
  fiberLiquidityBridgeTopUpAmountMinor?: number;
  fiberLiquidityBridgeTopUpStatus?: string;
  fiberLiquidityBridgeTopUpCreatedAt?: Date | string;
};

const CHANNEL_OPEN_WAIT_MS = 2 * 60 * 1000;
const NODE_FUNDING_CAPACITY_BUFFER_MINOR = toMinorUnits('62', 'CKB');

type FiberReadinessForLiquidity = Awaited<ReturnType<typeof getFiberNodeReadiness>>;

function payoutOutboundCapacities(readiness: FiberReadinessForLiquidity): number[] {
  const targetPubkey = env.FIBER_EXIT_KEYSEND_TARGET_PUBKEY.trim().toLowerCase();
  const channels = readiness.channels.channels ?? [];
  const payoutChannels = targetPubkey
    ? channels.filter((channel) => channel.peerId?.toLowerCase() === targetPubkey)
    : channels;
  return payoutChannels
    .map((channel) => channel.outboundCapacityMinor)
    .filter((value): value is number => value != null && value > 0);
}

export function getFiberPayoutLiquiditySnapshot(readiness: FiberReadinessForLiquidity): FiberPayoutLiquiditySnapshot {
  const capacities = payoutOutboundCapacities(readiness);
  return {
    channelCount: capacities.length,
    totalOutboundCapacityMinor: capacities.length > 0 ? capacities.reduce((sum, value) => sum + value, 0) : undefined,
    maxOutboundCapacityMinor: capacities.length > 0 ? Math.max(...capacities) : undefined
  };
}

export async function getCurrentFiberPayoutLiquiditySnapshot(): Promise<FiberPayoutLiquiditySnapshot> {
  return getFiberPayoutLiquiditySnapshot(await getFiberNodeReadiness());
}

function sufficientOutboundLiquidity(input: { readiness: FiberReadinessForLiquidity; amountMinor: number }): boolean {
  if ((input.readiness.channels.activeCount ?? 0) <= 0) return false;
  const snapshot = getFiberPayoutLiquiditySnapshot(input.readiness);
  if (snapshot.totalOutboundCapacityMinor == null) return false;
  return snapshot.totalOutboundCapacityMinor >= input.amountMinor;
}

async function recipientBridgeState(sessionId: string, recipientIndex: number): Promise<RecipientBridgeState> {
  const session = await SessionModel.findOne({ publicId: sessionId }).select('recipientWallets').lean<{ recipientWallets?: RecipientBridgeState[] } | null>();
  return session?.recipientWallets?.[recipientIndex] ?? {};
}

async function setRecipientBridgeFields(sessionId: string, recipientIndex: number, fields: Record<string, unknown>): Promise<void> {
  const setFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    setFields['recipientWallets.' + recipientIndex + '.' + key] = value;
  }
  await SessionModel.updateOne({ publicId: sessionId }, { $set: setFields });
}

async function requireCommittedBridgeTransaction(txHash: string): Promise<void> {
  const tx = await getCkbTransaction(txHash).catch(() => null);
  if (tx?.tx_status.status !== 'committed') {
    throw new ApiError(409, 'FIBER_LIQUIDITY_BRIDGE_PENDING', 'Reserved vault liquidity has been sent to the Fiber node funding lock and is waiting for CKB confirmation. The payout worker will retry automatically.');
  }
}

function channelOpenStillFresh(requestedAt?: Date | string): boolean {
  if (!requestedAt) return false;
  const timestamp = new Date(requestedAt).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now() - CHANNEL_OPEN_WAIT_MS;
}

type PendingChannelOpenProbe = { hasOpenPending: boolean; failureDetail?: string };

function bridgeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function bridgeString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function bridgeChannels(raw: unknown): Record<string, unknown>[] {
  const record = bridgeRecord(raw);
  const channels = Array.isArray(record.channels) ? record.channels : Array.isArray(raw) ? raw : [];
  return channels.map((channel) => bridgeRecord(channel));
}

function pendingChannelStateText(channel: Record<string, unknown>): string {
  const state = bridgeRecord(channel.state);
  return [
    bridgeString(state, ['state_name', 'stateName']),
    bridgeString(state, ['state_flags', 'stateFlags']),
    bridgeString(channel, ['failure_detail', 'failureDetail'])
  ].filter(Boolean).join(' ');
}

function isFailedPendingChannel(channel: Record<string, unknown>): boolean {
  const text = pendingChannelStateText(channel).toLowerCase();
  return text.includes('funding_aborted') || text.includes('failed') || text.includes('closed') || text.includes('aborted');
}

async function nodeFundingCapacityMinor(address: string): Promise<number> {
  const lock = parseCkbAddress(address);
  const cells = await listLiveVaultCells({ lock, limit: 100 });
  return cells.reduce((total, cell) => total + cell.capacityShannons, 0);
}

async function ensureNodeFundingCapacity(input: {
  ownerWalletId: string;
  sessionId: string;
  recipientIndex: number;
  nodeFundingAddress: string;
  requiredMinor: number;
  currency: string;
  state: RecipientBridgeState;
}): Promise<void> {
  if (input.state.fiberLiquidityBridgeTopUpTxHash && input.state.fiberLiquidityBridgeTopUpStatus !== 'confirmed') {
    await requireCommittedBridgeTransaction(input.state.fiberLiquidityBridgeTopUpTxHash);
    await setRecipientBridgeFields(input.sessionId, input.recipientIndex, { fiberLiquidityBridgeTopUpStatus: 'confirmed' });
  }

  const requiredWithBufferMinor = input.requiredMinor + NODE_FUNDING_CAPACITY_BUFFER_MINOR;
  const liveCapacityMinor = await nodeFundingCapacityMinor(input.nodeFundingAddress);
  if (liveCapacityMinor >= requiredWithBufferMinor) return;

  const topUpMinor = requiredWithBufferMinor - liveCapacityMinor;
  const bridge = await executeVaultLiquidityBridge({
    ownerWalletId: input.ownerWalletId,
    sessionId: input.sessionId,
    nodeFundingAddress: input.nodeFundingAddress,
    amountMinor: topUpMinor,
    currency: input.currency
  });

  await setRecipientBridgeFields(input.sessionId, input.recipientIndex, {
    fiberLiquidityBridgeTopUpTxHash: bridge.proofId,
    fiberLiquidityBridgeTopUpAmountMinor: topUpMinor,
    fiberLiquidityBridgeTopUpStatus: 'pending_confirmation',
    fiberLiquidityBridgeTopUpCreatedAt: new Date()
  });
  await writeAuditLog({
    actorWalletId: input.ownerWalletId,
    action: 'fiber.liquidity_bridge_top_up_submitted',
    targetType: 'session',
    targetId: input.sessionId,
    metadata: { recipientIndex: input.recipientIndex, amountMinor: topUpMinor, requiredMinor: input.requiredMinor, liveCapacityMinor, txHash: bridge.proofId, nodeFundingAddress: input.nodeFundingAddress }
  });

  throw new ApiError(409, 'FIBER_LIQUIDITY_BRIDGE_PENDING', 'Reserved vault liquidity was topped up for Fiber channel funding. Waiting for CKB confirmation before opening the channel.');
}

async function inspectPendingChannelOpen(): Promise<PendingChannelOpenProbe> {
  const response = await fetch(env.FIBER_RPC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.FIBER_API_KEY ? { Authorization: 'Bearer ' + env.FIBER_API_KEY } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'list_channels', params: [{ only_pending: true }] })
  });

  const payload = await response.json().catch(() => null) as { result?: unknown; error?: { message?: string } } | null;
  if (!response.ok || payload?.error) return { hasOpenPending: true };

  const channels = bridgeChannels(payload?.result);
  if (channels.length === 0) return { hasOpenPending: false };

  const openPending = channels.filter((channel) => !isFailedPendingChannel(channel));
  if (openPending.length > 0) return { hasOpenPending: true };

  return {
    hasOpenPending: false,
    failureDetail: pendingChannelStateText(channels[0]) || 'Fiber channel funding attempt was aborted.'
  };
}


export async function ensureVaultFundedFiberLiquidity(input: FiberLiquidityBridgeInput): Promise<FiberLiquidityBridgeReadyResult> {
  const readiness = await getFiberNodeReadiness();
  if (!readiness.reachable) {
    throw new ApiError(503, 'FIBER_NODE_UNREACHABLE', 'Fiber node is not reachable, so vault liquidity cannot be routed through Fiber yet.');
  }

  const state = await recipientBridgeState(input.sessionId, input.recipientIndex);
  if (state.fiberChannelOpenProofId && sufficientOutboundLiquidity({ readiness, amountMinor: input.amountMinor })) {
    return { ready: true, outboundCapacityMinor: getFiberPayoutLiquiditySnapshot(readiness).totalOutboundCapacityMinor };
  }

  const nodeFundingAddress = readiness.node?.fundingAddress;
  if (!nodeFundingAddress) {
    throw new ApiError(503, 'FIBER_NODE_FUNDING_ADDRESS_MISSING', 'Fiber node did not expose a funding address for vault-funded channel liquidity.');
  }

  if (!state.fiberLiquidityBridgeTxHash) {
    const bridge = await executeVaultLiquidityBridge({
      ownerWalletId: input.ownerWalletId,
      sessionId: input.sessionId,
      nodeFundingAddress,
      amountMinor: input.amountMinor,
      currency: input.currency
    });

    await setRecipientBridgeFields(input.sessionId, input.recipientIndex, {
      fiberLiquidityBridgeTxHash: bridge.proofId,
      fiberLiquidityBridgeAmountMinor: input.amountMinor,
      fiberLiquidityBridgeStatus: 'pending_confirmation',
      fiberLiquidityBridgeCreatedAt: new Date()
    });
    await writeAuditLog({
      actorWalletId: input.ownerWalletId,
      action: 'fiber.liquidity_bridge_submitted',
      targetType: 'session',
      targetId: input.sessionId,
      metadata: { recipientIndex: input.recipientIndex, amountMinor: input.amountMinor, txHash: bridge.proofId, nodeFundingAddress }
    });

    throw new ApiError(409, 'FIBER_LIQUIDITY_BRIDGE_PENDING', 'Reserved vault funds were moved toward Fiber channel liquidity. Waiting for CKB confirmation before opening the channel.');
  }

  await requireCommittedBridgeTransaction(state.fiberLiquidityBridgeTxHash);
  if (state.fiberLiquidityBridgeStatus !== 'confirmed') {
    await setRecipientBridgeFields(input.sessionId, input.recipientIndex, { fiberLiquidityBridgeStatus: 'confirmed' });
  }

  const afterBridgeReadiness = await getFiberNodeReadiness();
  const afterBridgeLiquidity = getFiberPayoutLiquiditySnapshot(afterBridgeReadiness);
  if (state.fiberChannelOpenProofId && sufficientOutboundLiquidity({ readiness: afterBridgeReadiness, amountMinor: input.amountMinor })) {
    return { ready: true, outboundCapacityMinor: afterBridgeLiquidity.totalOutboundCapacityMinor };
  }

  if (state.fiberChannelOpenProofId) {
    const pendingOpen = await inspectPendingChannelOpen();
    const freshOpen = channelOpenStillFresh(state.fiberChannelOpenRequestedAt);
    if (pendingOpen.hasOpenPending && freshOpen) {
      throw new ApiError(409, 'FIBER_CHANNEL_OPEN_PENDING', 'Fiber channel open is already submitted and waiting to become active. The payout worker will retry automatically.');
    }
    if (!freshOpen || pendingOpen.failureDetail) {
      await setRecipientBridgeFields(input.sessionId, input.recipientIndex, {
        fiberChannelOpenFailureDetail: pendingOpen.failureDetail ?? 'Previous Fiber channel open did not activate within the wait window; opening additional liquidity.',
        fiberChannelOpenFailedAt: new Date()
      });
    }
  }

  try {
    const staleExistingChannel = Boolean(
      state.fiberChannelOpenProofId &&
      !channelOpenStillFresh(state.fiberChannelOpenRequestedAt)
    );
    const missingLiquidityMinor = !state.fiberChannelOpenProofId || staleExistingChannel
      ? input.amountMinor
      : Math.max(input.amountMinor - (afterBridgeLiquidity.totalOutboundCapacityMinor ?? 0), 1);
    await ensureNodeFundingCapacity({
      ownerWalletId: input.ownerWalletId,
      sessionId: input.sessionId,
      recipientIndex: input.recipientIndex,
      nodeFundingAddress,
      requiredMinor: missingLiquidityMinor,
      currency: input.currency,
      state
    });

    const channel = await openFiberTestChannel({
      amount: fromMinorUnits(missingLiquidityMinor, input.currency),
      actorWalletId: input.ownerWalletId,
      exactAmount: true
    });
    await setRecipientBridgeFields(input.sessionId, input.recipientIndex, {
      fiberChannelOpenProofId: channel.proofId,
      fiberChannelOpenAmountMinor: channel.amountMinor,
      fiberChannelOpenRequestedAt: new Date()
    });
    await writeAuditLog({
      actorWalletId: input.ownerWalletId,
      action: 'fiber.vault_funded_channel_open_submitted',
      targetType: 'session',
      targetId: input.sessionId,
      metadata: { recipientIndex: input.recipientIndex, amountMinor: input.amountMinor, missingLiquidityMinor, peerId: channel.peerId, channelId: channel.networkSessionId, proofId: channel.proofId }
    });
    throw new ApiError(409, 'FIBER_CHANNEL_OPEN_PENDING', 'Vault-funded Fiber channel open was submitted. Waiting for the channel to become active before sending payment.');
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error && error.message ? error.message : 'Fiber channel open failed after vault liquidity bridge.';
    throw new ApiError(502, 'FIBER_CHANNEL_OPEN_FAILED', message);
  }
}
