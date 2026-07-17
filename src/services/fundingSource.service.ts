import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { env } from '../config/env.js';
import {
  allocationRemainingMinor,
  fundingSourceState,
  securedReclaimableMinor,
  type FundingGuarantee,
  type FundingMode,
  type FundingRiskLabel,
  type FundingSourceKind
} from '../domain/funding.js';
import { assetIdForLegacyCurrency, PAYMENT_CONTRACT_VERSION } from '../domain/payment.js';
import { ApiError } from '../lib/errors.js';
import { legacyMinorToAtomicAmount } from '../lib/money.js';
import {
  FundingAllocationModel,
  FundingSourceModel,
  type FundingAllocationRecord,
  type FundingSourceRecord
} from '../models/fundingSource.model.js';

const SOURCE_FRESHNESS_MS = 5 * 60 * 1000;

function stableId(prefix: string, value: string): string {
  return prefix + '_' + createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function securedFundingSourceId(ownerWalletId: string, sourceReference: string): string {
  return stableId('fsrc', ['secured', ownerWalletId, sourceReference].join(':'));
}

export function connectedFundingSourceId(ownerWalletId: string, rail: string, assetId: string): string {
  return stableId('fsrc', ['connected', ownerWalletId, rail, assetId].join(':'));
}

function amountFields(prefix: string, minor: number): Record<string, unknown> {
  return {
    [prefix + 'Minor']: minor,
    [prefix + 'Atomic']: legacyMinorToAtomicAmount(minor)
  };
}

function refreshSourceAmounts(source: {
  mode: FundingMode;
  availableMinor: number;
  authorizedMinor: number;
  lockedMinor: number;
  reservedMinor: number;
  spentMinor: number;
  releasedMinor: number;
  reclaimableMinor: number;
  networkProofId?: string | null;
  balanceObservedAt?: Date | null;
  staleAt?: Date | null;
  state: string;
  set(path: string, value: unknown): void;
}): void {
  source.reclaimableMinor = source.mode === 'secured_autopay'
    ? securedReclaimableMinor(source)
    : Math.max(0, source.availableMinor - source.authorizedMinor);
  const values = {
    available: source.availableMinor,
    authorized: source.authorizedMinor,
    locked: source.lockedMinor,
    reserved: source.reservedMinor,
    spent: source.spentMinor,
    released: source.releasedMinor,
    reclaimable: source.reclaimableMinor
  };
  for (const field of Object.keys(values) as Array<keyof typeof values>) {
    source.set(field + 'Atomic', legacyMinorToAtomicAmount(values[field]));
  }
  source.state = fundingSourceState({
    mode: source.mode,
    availableMinor: source.availableMinor,
    authorizedMinor: source.authorizedMinor,
    lockedMinor: source.lockedMinor,
    reservedMinor: source.reservedMinor,
    hasNetworkProof: Boolean(source.networkProofId),
    observedAt: source.balanceObservedAt,
    staleAt: source.staleAt
  });
}

function refreshAllocationAmounts(allocation: {
  authorizedMinor: number;
  spentMinor: number;
  releasedMinor: number;
  remainingMinor: number;
  set(path: string, value: unknown): void;
}): void {
  allocation.remainingMinor = allocationRemainingMinor(allocation);
  const values = {
    authorized: allocation.authorizedMinor,
    spent: allocation.spentMinor,
    released: allocation.releasedMinor,
    remaining: allocation.remainingMinor
  };
  for (const field of Object.keys(values) as Array<keyof typeof values>) {
    allocation.set(field + 'Atomic', legacyMinorToAtomicAmount(values[field]));
  }
}

export interface FundingSourceDto {
  contractVersion: typeof PAYMENT_CONTRACT_VERSION;
  id: string;
  mode: FundingMode;
  sourceKind: FundingSourceKind;
  sourceReference: string;
  connectorId?: string;
  rail: string;
  network: string;
  assetId: string;
  guarantee: FundingGuarantee;
  riskLabel: FundingRiskLabel;
  state: string;
  balances: {
    availableAtomic: string;
    authorizedAtomic: string;
    lockedAtomic: string;
    policyReservedAtomic: string;
    spentAtomic: string;
    releasedAtomic: string;
    reclaimableAtomic: string;
  };
  proof?: { id: string; type?: string; observedAt?: string };
  freshness: { observedAt?: string; staleAt?: string; stale: boolean };
  failure?: { code: string; message?: string };
}

export function toFundingSourceDto(source: FundingSourceRecord): FundingSourceDto {
  const now = Date.now();
  const stale = Boolean(source.staleAt && source.staleAt.getTime() <= now);
  return {
    contractVersion: PAYMENT_CONTRACT_VERSION,
    id: source.sourceId,
    mode: source.mode,
    sourceKind: source.sourceKind,
    sourceReference: source.sourceReference,
    connectorId: source.connectorId ?? undefined,
    rail: source.rail,
    network: source.network,
    assetId: source.assetId,
    guarantee: source.guarantee,
    riskLabel: source.riskLabel,
    state: stale && source.state !== 'failed' && source.state !== 'revoked' ? 'stale' : source.state,
    balances: {
      availableAtomic: source.availableAtomic,
      authorizedAtomic: source.authorizedAtomic,
      lockedAtomic: source.lockedAtomic,
      policyReservedAtomic: source.reservedAtomic,
      spentAtomic: source.spentAtomic,
      releasedAtomic: source.releasedAtomic,
      reclaimableAtomic: source.reclaimableAtomic
    },
    proof: source.networkProofId ? {
      id: source.networkProofId,
      type: source.networkProofType ?? undefined,
      observedAt: source.proofObservedAt?.toISOString()
    } : undefined,
    freshness: {
      observedAt: (source.balanceObservedAt ?? source.proofObservedAt)?.toISOString(),
      staleAt: source.staleAt?.toISOString(),
      stale
    },
    failure: source.failureCode ? { code: source.failureCode, message: source.failureMessage ?? undefined } : undefined
  };
}

export async function listFundingSources(ownerWalletId: string): Promise<FundingSourceDto[]> {
  const sources = await FundingSourceModel.find({ ownerWalletId }).sort({ createdAt: 1 }).lean<FundingSourceRecord[]>();
  return sources.map(toFundingSourceDto);
}

export async function ensureConnectedWalletSource(input: {
  ownerWalletId: string;
  walletAddress: string;
  rail?: string;
  assetId?: string;
  session?: ClientSession;
}): Promise<FundingSourceRecord> {
  const rail = input.rail ?? 'ckb_onchain';
  const assetId = input.assetId ?? assetIdForLegacyCurrency('CKB');
  const sourceId = connectedFundingSourceId(input.ownerWalletId, rail, assetId);
  await FundingSourceModel.updateOne(
    { sourceId },
    {
      $setOnInsert: {
        sourceId,
        ownerWalletId: input.ownerWalletId,
        mode: 'connected_wallet',
        sourceKind: 'external_wallet',
        sourceReference: input.walletAddress,
        rail,
        network: env.FIBER_NETWORK,
        assetId,
        moneyContractVersion: 2,
        guarantee: 'authorization_only',
        riskLabel: 'none',
        state: 'unverified',
        ...amountFields('available', 0),
        ...amountFields('authorized', 0),
        ...amountFields('locked', 0),
        ...amountFields('reserved', 0),
        ...amountFields('spent', 0),
        ...amountFields('released', 0),
        ...amountFields('reclaimable', 0)
      }
    },
    { upsert: true, session: input.session }
  );
  const source = await FundingSourceModel.findOne({ sourceId }).session(input.session ?? null).lean<FundingSourceRecord | null>();
  if (!source) throw new Error('Connected-wallet funding source was not created.');
  return source;
}

export async function recordConnectedWalletBalance(input: {
  ownerWalletId: string;
  walletAddress: string;
  availableMinor: number;
  observedAt?: Date;
}): Promise<void> {
  const ensuredSource = await ensureConnectedWalletSource(input);
  const source = await FundingSourceModel.findOne({ sourceId: ensuredSource.sourceId });
  if (!source) throw new Error('Connected-wallet funding source disappeared before balance refresh.');
  const observedAt = input.observedAt ?? new Date();
  source.availableMinor = input.availableMinor;
  source.guarantee = 'balance_observed';
  source.balanceObservedAt = observedAt;
  source.staleAt = new Date(observedAt.getTime() + SOURCE_FRESHNESS_MS);
  source.failureCode = undefined;
  source.failureMessage = undefined;
  refreshSourceAmounts(source);
  await source.save();
}

export async function recordSecuredFundingProof(input: {
  ownerWalletId: string;
  sourceReference: string;
  amountMinor: number;
  proofId: string;
  proofType: string;
  observedAt: Date;
  legacyOperatorVault?: boolean;
  session: ClientSession;
}): Promise<string> {
  const sourceId = securedFundingSourceId(input.ownerWalletId, input.sourceReference);
  let source = await FundingSourceModel.findOne({ sourceId }).session(input.session);
  if (!source) {
    const [created] = await FundingSourceModel.create([{
      sourceId,
      ownerWalletId: input.ownerWalletId,
      mode: 'secured_autopay',
      sourceKind: input.legacyOperatorVault ? 'legacy_operator_vault' : 'network_contract',
      sourceReference: input.sourceReference,
      connectorId: 'fiber-rpc',
      rail: 'ckb_onchain',
      network: env.FIBER_NETWORK,
      assetId: assetIdForLegacyCurrency('CKB'),
      moneyContractVersion: 2,
      guarantee: 'network_locked_operator_controlled',
      riskLabel: input.legacyOperatorVault ? 'legacy_operator_vault' : 'unaudited_operator_contract',
      state: 'available',
      ...amountFields('available', input.amountMinor),
      ...amountFields('authorized', 0),
      ...amountFields('locked', input.amountMinor),
      ...amountFields('reserved', 0),
      ...amountFields('spent', 0),
      ...amountFields('released', 0),
      ...amountFields('reclaimable', input.amountMinor),
      networkProofId: input.proofId,
      networkProofType: input.proofType,
      proofObservedAt: input.observedAt,
      balanceObservedAt: input.observedAt,
      staleAt: new Date(input.observedAt.getTime() + SOURCE_FRESHNESS_MS)
    }], { session: input.session });
    return created.sourceId;
  }
  source.lockedMinor += input.amountMinor;
  source.availableMinor = source.lockedMinor;
  source.networkProofId = input.proofId;
  source.networkProofType = input.proofType;
  source.proofObservedAt = input.observedAt;
  source.balanceObservedAt = input.observedAt;
  source.staleAt = new Date(input.observedAt.getTime() + SOURCE_FRESHNESS_MS);
  source.failureCode = undefined;
  source.failureMessage = undefined;
  refreshSourceAmounts(source);
  await source.save({ session: input.session });
  return source.sourceId;
}

export async function recordSecuredFundingBalance(input: {
  ownerWalletId: string;
  sourceReference: string;
  lockedMinor: number;
  observedAt?: Date;
}): Promise<void> {
  const source = await FundingSourceModel.findOne({
    ownerWalletId: input.ownerWalletId,
    mode: 'secured_autopay',
    sourceReference: input.sourceReference
  });
  if (!source) return;
  const observedAt = input.observedAt ?? new Date();
  source.lockedMinor = input.lockedMinor;
  source.availableMinor = input.lockedMinor;
  source.lockedAtomic = legacyMinorToAtomicAmount(input.lockedMinor);
  source.availableAtomic = legacyMinorToAtomicAmount(input.lockedMinor);
  source.balanceObservedAt = observedAt;
  source.staleAt = new Date(observedAt.getTime() + SOURCE_FRESHNESS_MS);
  if (input.lockedMinor < source.reservedMinor) {
    source.reclaimableMinor = 0;
    source.reclaimableAtomic = legacyMinorToAtomicAmount(0);
    source.state = 'insufficient';
    source.failureCode = 'SECURED_FUNDING_AGGREGATE_INSUFFICIENT';
    source.failureMessage = 'Observed network-locked funds are below active pass allocations.';
  } else {
    source.failureCode = undefined;
    source.failureMessage = undefined;
    refreshSourceAmounts(source);
  }
  await source.save();
}

export interface FundingSelection {
  sourceId: string;
  mode: FundingMode;
  guarantee: FundingGuarantee;
  riskLabel: FundingRiskLabel;
  executionReady: boolean;
  failureCode?: string;
}

export async function resolveFundingSelection(input: {
  ownerWalletId: string;
  walletAddress: string;
  amountMinor: number;
  mode?: FundingMode;
  sourceId?: string;
}): Promise<FundingSelection> {
  let source: FundingSourceRecord | null = null;
  if (input.sourceId) {
    source = await FundingSourceModel.findOne({ sourceId: input.sourceId, ownerWalletId: input.ownerWalletId }).lean<FundingSourceRecord | null>();
    if (!source) throw new ApiError(404, 'FUNDING_SOURCE_NOT_FOUND', 'The selected funding source was not found for this wallet.');
    if (input.mode && source.mode !== input.mode) throw new ApiError(400, 'FUNDING_MODE_MISMATCH', 'The selected source does not match the requested funding mode.');
  } else if (input.mode === 'secured_autopay' || !input.mode) {
    const now = new Date();
    source = await FundingSourceModel.findOne({
      ownerWalletId: input.ownerWalletId,
      mode: 'secured_autopay',
      networkProofId: { $exists: true, $ne: '' },
      state: 'available',
      staleAt: { $gt: now },
      $expr: { $gte: [{ $subtract: ['$lockedMinor', '$reservedMinor'] }, input.amountMinor] }
    }).sort({ riskLabel: 1, createdAt: 1 }).lean<FundingSourceRecord | null>();
    if (input.mode === 'secured_autopay' && !source) {
      throw new ApiError(402, 'SECURED_FUNDING_INSUFFICIENT', 'No proof-backed secured funding source has enough unallocated value.');
    }
  }
  if (!source) source = await ensureConnectedWalletSource({ ownerWalletId: input.ownerWalletId, walletAddress: input.walletAddress });
  const secured = source.mode === 'secured_autopay';
  const proofStale = Boolean(source.staleAt && source.staleAt.getTime() <= Date.now());
  return {
    sourceId: source.sourceId,
    mode: source.mode,
    guarantee: source.guarantee,
    riskLabel: source.riskLabel,
    executionReady: secured && Boolean(source.networkProofId) && !proofStale && !['unverified', 'insufficient', 'failed', 'revoked'].includes(source.state),
    failureCode: secured
      ? !source.networkProofId
        ? 'SECURED_FUNDING_PROOF_REQUIRED'
        : proofStale ? 'SECURED_FUNDING_PROOF_STALE' : source.failureCode ?? undefined
      : 'CONNECTED_WALLET_EXECUTION_UNAVAILABLE'
  };
}

export async function allocateFundingForSession(input: {
  selection: FundingSelection;
  ownerWalletId: string;
  sessionId: string;
  amountMinor: number;
  session: ClientSession;
}): Promise<void> {
  const source = await FundingSourceModel.findOne({
    sourceId: input.selection.sourceId,
    ownerWalletId: input.ownerWalletId,
    mode: input.selection.mode
  }).session(input.session);
  if (!source) throw new ApiError(404, 'FUNDING_SOURCE_NOT_FOUND', 'Funding source disappeared before pass allocation.');
  if (source.mode === 'secured_autopay') {
    if (!source.networkProofId) throw new ApiError(409, 'SECURED_FUNDING_PROOF_REQUIRED', 'Secured auto-pay cannot be allocated without a network proof.');
    if (source.staleAt && source.staleAt.getTime() <= Date.now()) throw new ApiError(409, 'SECURED_FUNDING_PROOF_STALE', 'Secured auto-pay requires a fresh network proof.');
    const reclaimable = securedReclaimableMinor(source);
    if (reclaimable < input.amountMinor) throw new ApiError(402, 'SECURED_FUNDING_INSUFFICIENT', 'Secured funding was allocated by another pass.');
    source.reservedMinor += input.amountMinor;
  }
  source.authorizedMinor += input.amountMinor;
  refreshSourceAmounts(source);
  await source.save({ session: input.session });

  await FundingAllocationModel.create([{
    allocationId: 'falloc_' + randomUUID(),
    sourceId: source.sourceId,
    sessionId: input.sessionId,
    ownerWalletId: input.ownerWalletId,
    mode: source.mode,
    guarantee: source.guarantee,
    riskLabel: source.riskLabel,
    state: 'active',
    assetId: source.assetId,
    moneyContractVersion: 2,
    ...amountFields('authorized', input.amountMinor),
    ...amountFields('spent', 0),
    ...amountFields('released', 0),
    ...amountFields('remaining', input.amountMinor),
    networkProofIdAtAllocation: source.mode === 'secured_autopay' ? source.networkProofId : undefined,
    activatedAt: new Date()
  }], { session: input.session });
}

export async function topUpFundingAllocation(sessionId: string, amountMinor: number, mongoSession: ClientSession): Promise<void> {
  const allocation = await FundingAllocationModel.findOne({ sessionId, state: 'active' }).session(mongoSession);
  if (!allocation) return;
  const source = await FundingSourceModel.findOne({ sourceId: allocation.sourceId }).session(mongoSession);
  if (!source) throw new Error('Funding source is missing for pass top up.');
  if (source.mode === 'secured_autopay') {
    if (!source.networkProofId) throw new ApiError(409, 'SECURED_FUNDING_PROOF_REQUIRED', 'Secured auto-pay top up requires a network proof.');
    if (source.staleAt && source.staleAt.getTime() <= Date.now()) throw new ApiError(409, 'SECURED_FUNDING_PROOF_STALE', 'Secured auto-pay top up requires a fresh network proof.');
    if (securedReclaimableMinor(source) < amountMinor) throw new ApiError(402, 'SECURED_FUNDING_INSUFFICIENT', 'Secured funding cannot cover this pass top up.');
    source.reservedMinor += amountMinor;
  }
  source.authorizedMinor += amountMinor;
  allocation.authorizedMinor += amountMinor;
  refreshAllocationAmounts(allocation);
  refreshSourceAmounts(source);
  await source.save({ session: mongoSession });
  await allocation.save({ session: mongoSession });
}

export async function spendFundingAllocation(sessionId: string, amountMinor: number, mongoSession: ClientSession): Promise<boolean> {
  const allocation = await FundingAllocationModel.findOne({ sessionId }).session(mongoSession);
  if (!allocation) return false;
  if (allocation.state !== 'active') throw new Error('Funding allocation is not active.');
  if (allocationRemainingMinor(allocation) < amountMinor) throw new Error('Funding allocation cannot cover finalized spend.');
  const source = await FundingSourceModel.findOne({ sourceId: allocation.sourceId }).session(mongoSession);
  if (!source) throw new Error('Funding source is missing for finalized spend.');
  if (source.mode === 'secured_autopay') {
    if (source.reservedMinor < amountMinor || source.lockedMinor < amountMinor) throw new Error('Secured source counters cannot cover finalized spend.');
    source.reservedMinor -= amountMinor;
    source.lockedMinor -= amountMinor;
    source.availableMinor = source.lockedMinor;
  }
  if (source.authorizedMinor < amountMinor) throw new Error('Funding source authorization cannot cover finalized spend.');
  source.authorizedMinor -= amountMinor;
  source.spentMinor += amountMinor;
  allocation.spentMinor += amountMinor;
  refreshAllocationAmounts(allocation);
  if (allocation.remainingMinor === 0) {
    allocation.state = 'exhausted';
    allocation.exhaustedAt = new Date();
  }
  refreshSourceAmounts(source);
  await source.save({ session: mongoSession });
  await allocation.save({ session: mongoSession });
  return true;
}

export async function releaseFundingAllocation(sessionId: string, mongoSession: ClientSession): Promise<number> {
  const allocation = await FundingAllocationModel.findOne({ sessionId }).session(mongoSession);
  if (!allocation || allocation.state === 'released' || allocation.state === 'exhausted') return 0;
  const remainingMinor = allocationRemainingMinor(allocation);
  const source = await FundingSourceModel.findOne({ sourceId: allocation.sourceId }).session(mongoSession);
  if (!source) throw new Error('Funding source is missing for pass release.');
  if (source.mode === 'secured_autopay') {
    if (source.reservedMinor < remainingMinor) throw new Error('Secured source reservation cannot be released consistently.');
    source.reservedMinor -= remainingMinor;
  }
  if (source.authorizedMinor < remainingMinor) throw new Error('Funding source authorization cannot be released consistently.');
  source.authorizedMinor -= remainingMinor;
  source.releasedMinor += remainingMinor;
  allocation.releasedMinor += remainingMinor;
  allocation.state = 'released';
  allocation.releasedAt = new Date();
  refreshAllocationAmounts(allocation);
  refreshSourceAmounts(source);
  await source.save({ session: mongoSession });
  await allocation.save({ session: mongoSession });
  return remainingMinor;
}

export async function releaseFundingAllocationTransaction(sessionId: string): Promise<number> {
  let releasedMinor = 0;
  await FundingAllocationModel.db.transaction(async (mongoSession) => {
    releasedMinor = await releaseFundingAllocation(sessionId, mongoSession);
  });
  return releasedMinor;
}

export interface FundingExecutionStatus {
  ready: boolean;
  code?: string;
  message?: string;
}

export async function fundingExecutionStatus(sessionId: string, amountMinor: number): Promise<FundingExecutionStatus> {
  const allocation = await FundingAllocationModel.findOne({ sessionId }).lean<FundingAllocationRecord | null>();
  if (!allocation) return { ready: true };
  if (allocation.state !== 'active' || allocation.remainingMinor < amountMinor) {
    return { ready: false, code: 'FUNDING_ALLOCATION_INSUFFICIENT', message: 'The pass funding allocation cannot cover this execution.' };
  }
  const source = await FundingSourceModel.findOne({ sourceId: allocation.sourceId }).lean<FundingSourceRecord | null>();
  if (!source) return { ready: false, code: 'FUNDING_SOURCE_NOT_FOUND', message: 'The pass funding source is unavailable.' };
  if (source.failureCode) return { ready: false, code: source.failureCode, message: source.failureMessage ?? 'The funding source is in a failed state.' };
  if (source.mode === 'secured_autopay') {
    if (!source.networkProofId) return { ready: false, code: 'SECURED_FUNDING_PROOF_REQUIRED', message: 'Secured auto-pay has no network proof.' };
    if (source.staleAt && source.staleAt.getTime() <= Date.now()) {
      return { ready: false, code: 'SECURED_FUNDING_PROOF_STALE', message: 'Secured funding has not been observed on the network recently enough.' };
    }
    if (source.lockedMinor < source.reservedMinor || source.lockedMinor < amountMinor || source.reservedMinor < amountMinor) {
      return { ready: false, code: 'SECURED_FUNDING_INSUFFICIENT', message: 'Proof-backed locked funds cannot cover this execution.' };
    }
    return { ready: true };
  }
  if (!source.balanceObservedAt) return { ready: false, code: 'CONNECTED_WALLET_BALANCE_UNVERIFIED', message: 'Connected wallet liquidity has not been observed.' };
  if (source.staleAt && source.staleAt.getTime() <= Date.now()) return { ready: false, code: 'CONNECTED_WALLET_BALANCE_STALE', message: 'Connected wallet liquidity observation is stale.' };
  if (source.availableMinor < amountMinor) return { ready: false, code: 'CONNECTED_WALLET_LIQUIDITY_INSUFFICIENT', message: 'Connected wallet liquidity is below the requested execution amount.' };
  return { ready: true };
}
