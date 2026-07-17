import { env } from '../config/env.js';
import { assetIdForLegacyCurrency } from '../domain/payment.js';
import { fallbackMinorUnits, legacyMinorToAtomicAmount } from '../lib/money.js';
import { FundingAllocationModel, FundingSourceModel } from '../models/fundingSource.model.js';
import { SessionModel } from '../models/session.model.js';
import { WalletFundingModel } from '../models/walletFunding.model.js';
import { WalletModel } from '../models/wallet.model.js';
import { securedFundingSourceId } from '../services/fundingSource.service.js';

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value as string | number | Date);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

function legacyMinor(record: Record<string, unknown>, minorField: string, valueField: string): number {
  return fallbackMinorUnits(
    typeof record[minorField] === 'number' ? record[minorField] as number : undefined,
    typeof record[valueField] === 'number' ? record[valueField] as number : undefined,
    optionalString(record.currency) ?? 'CKB'
  );
}

function moneyFields(prefix: string, amountMinor: number): Record<string, unknown> {
  return {
    [prefix + 'Minor']: amountMinor,
    [prefix + 'Atomic']: legacyMinorToAtomicAmount(amountMinor)
  };
}

export interface LegacyFundingMigrationSnapshot {
  source: Record<string, unknown>;
  allocations: Array<{ allocation: Record<string, unknown>; sessionPatch: Record<string, unknown> }>;
}

export function buildLegacyFundingMigrationSnapshot(input: {
  wallet: Record<string, unknown>;
  sessions: Record<string, unknown>[];
  funding: Record<string, unknown>[];
  now?: Date;
}): LegacyFundingMigrationSnapshot {
  const now = input.now ?? new Date();
  const walletId = String(input.wallet.walletId);
  const sourceReference = 'legacy_operator_vault:' + walletId;
  const sourceId = securedFundingSourceId(walletId, sourceReference);
  const confirmed = input.funding.filter((record) => record.status === 'confirmed');
  const proved = confirmed.filter((record) => optionalString(record.proofId) || optionalString(record.chainOutPoint));
  const lockedMinor = proved.reduce((total, record) => total + legacyMinor(record, 'amountMinor', 'amount'), 0);
  const latestProof = proved
    .slice()
    .sort((left, right) => (optionalDate(right.chainConfirmedAt)?.getTime() ?? 0) - (optionalDate(left.chainConfirmedAt)?.getTime() ?? 0))[0];
  const networkProofId = latestProof ? optionalString(latestProof.chainOutPoint) ?? optionalString(latestProof.proofId) : undefined;
  const proofObservedAt = latestProof ? optionalDate(latestProof.chainConfirmedAt) ?? optionalDate(latestProof.confirmedAt) : undefined;
  const staleAt = proofObservedAt ? new Date(proofObservedAt.getTime() + 5 * 60 * 1000) : undefined;
  const proofFresh = Boolean(staleAt && staleAt.getTime() > now.getTime());

  let activeAuthorizedMinor = 0;
  let sourceSpentMinor = 0;
  let sourceReleasedMinor = 0;
  const allocations = input.sessions.map((session) => {
    const sessionId = String(session.publicId);
    const authorizedMinor = legacyMinor(session, 'limitMinor', 'limit');
    const spentMinor = legacyMinor(session, 'spentMinor', 'spent');
    const remainingBeforeClose = Math.max(0, authorizedMinor - spentMinor);
    const active = session.status === 'active' || session.status === 'paused';
    const releasedMinor = active ? 0 : remainingBeforeClose;
    const remainingMinor = active ? remainingBeforeClose : 0;
    activeAuthorizedMinor += remainingMinor;
    sourceSpentMinor += spentMinor;
    sourceReleasedMinor += releasedMinor;
    const state = active ? (remainingMinor === 0 ? 'exhausted' : 'active') : 'released';
    return {
      allocation: {
        allocationId: 'falloc_legacy_' + sessionId,
        sourceId,
        sessionId,
        ownerWalletId: walletId,
        mode: 'secured_autopay',
        guarantee: 'network_locked_operator_controlled',
        riskLabel: 'legacy_operator_vault',
        state,
        assetId: assetIdForLegacyCurrency(optionalString(session.currency) ?? 'CKB'),
        moneyContractVersion: 2,
        ...moneyFields('authorized', authorizedMinor),
        ...moneyFields('spent', spentMinor),
        ...moneyFields('released', releasedMinor),
        ...moneyFields('remaining', remainingMinor),
        networkProofIdAtAllocation: networkProofId,
        activatedAt: optionalDate(session.createdAt) ?? now,
        releasedAt: state === 'released' ? optionalDate(session.updatedAt) ?? now : undefined,
        exhaustedAt: state === 'exhausted' ? optionalDate(session.updatedAt) ?? now : undefined
      },
      sessionPatch: {
        fundingMode: 'secured_autopay',
        fundingSourceId: sourceId,
        fundingGuarantee: 'network_locked_operator_controlled',
        fundingRiskLabel: 'legacy_operator_vault',
        fundingState: !networkProofId
          ? 'unverified'
          : lockedMinor < activeAuthorizedMinor
            ? 'insufficient'
            : activeAuthorizedMinor === lockedMinor
              ? 'fully_allocated'
              : 'available',
        fundingExecutionReady: Boolean(networkProofId && lockedMinor >= activeAuthorizedMinor),
        fundingFailureCode: networkProofId
          ? lockedMinor < activeAuthorizedMinor ? 'SECURED_FUNDING_AGGREGATE_INSUFFICIENT' : undefined
          : 'SECURED_FUNDING_PROOF_REQUIRED',
        fundingFailureMessage: networkProofId
          ? lockedMinor < activeAuthorizedMinor ? 'Historical locked value is below active pass allocations.' : undefined
          : 'Historical vault accounting has no independently verified network proof.',
        fundingAllocatedAt: optionalDate(session.createdAt) ?? now
      }
    };
  });
  const reservedMinor = activeAuthorizedMinor;
  const reclaimableMinor = Math.max(0, lockedMinor - reservedMinor);
  const state = !networkProofId
    ? 'unverified'
    : !proofFresh
      ? 'stale'
      : lockedMinor < reservedMinor
        ? 'insufficient'
        : reclaimableMinor === 0
          ? 'fully_allocated'
          : 'available';
  for (const item of allocations) {
    item.sessionPatch.fundingState = state;
    item.sessionPatch.fundingExecutionReady = Boolean(networkProofId && proofFresh && lockedMinor >= reservedMinor);
    item.sessionPatch.fundingFailureCode = !networkProofId
      ? 'SECURED_FUNDING_PROOF_REQUIRED'
      : !proofFresh
        ? 'SECURED_FUNDING_PROOF_STALE'
        : lockedMinor < reservedMinor ? 'SECURED_FUNDING_AGGREGATE_INSUFFICIENT' : undefined;
    item.sessionPatch.fundingFailureMessage = !networkProofId
      ? 'Historical vault accounting has no independently verified network proof.'
      : !proofFresh
        ? 'Historical network proof is stale and must be refreshed from live cells.'
        : lockedMinor < reservedMinor ? 'Historical locked value is below active pass allocations.' : undefined;
  }
  return {
    source: {
      sourceId,
      ownerWalletId: walletId,
      mode: 'secured_autopay',
      sourceKind: 'legacy_operator_vault',
      sourceReference,
      connectorId: 'fiber-rpc',
      rail: 'ckb_onchain',
      network: optionalString(latestProof?.network) ?? env.FIBER_NETWORK,
      assetId: assetIdForLegacyCurrency('CKB'),
      moneyContractVersion: 2,
      guarantee: 'network_locked_operator_controlled',
      riskLabel: 'legacy_operator_vault',
      state,
      ...moneyFields('available', lockedMinor),
      ...moneyFields('authorized', activeAuthorizedMinor),
      ...moneyFields('locked', lockedMinor),
      ...moneyFields('reserved', reservedMinor),
      ...moneyFields('spent', sourceSpentMinor),
      ...moneyFields('released', sourceReleasedMinor),
      ...moneyFields('reclaimable', reclaimableMinor),
      networkProofId,
      networkProofType: networkProofId ? 'legacy_ckb_deposit_record' : undefined,
      proofObservedAt,
      balanceObservedAt: proofObservedAt,
      staleAt,
      failureCode: state === 'unverified'
        ? 'SECURED_FUNDING_PROOF_REQUIRED'
        : state === 'stale'
          ? 'SECURED_FUNDING_PROOF_STALE'
          : state === 'insufficient' ? 'SECURED_FUNDING_AGGREGATE_INSUFFICIENT' : undefined,
      failureMessage: state === 'unverified'
        ? 'Legacy operator-vault balance is not treated as network-locked without proof.'
        : state === 'stale'
          ? 'Legacy operator-vault proof is stale and requires a live network observation.'
          : state === 'insufficient' ? 'Legacy locked value is below active pass allocations.' : undefined
    },
    allocations
  };
}

export async function migrateLegacyFundingSources(): Promise<void> {
  const walletCursor = WalletModel.collection.find<Record<string, unknown>>({});
  for await (const wallet of walletCursor) {
    const walletId = optionalString(wallet.walletId);
    if (!walletId) continue;
    const [sessions, funding] = await Promise.all([
      SessionModel.collection.find<Record<string, unknown>>({ ownerWalletId: walletId }).toArray(),
      WalletFundingModel.collection.find<Record<string, unknown>>({ walletId }).toArray()
    ]);
    if (sessions.length === 0 && funding.length === 0 && legacyMinor(wallet, 'balanceMinor', 'balance') === 0) continue;
    const snapshot = buildLegacyFundingMigrationSnapshot({ wallet, sessions, funding });
    await FundingSourceModel.collection.updateOne(
      { sourceId: snapshot.source.sourceId as string },
      { $setOnInsert: snapshot.source },
      { upsert: true }
    );
    for (const item of snapshot.allocations) {
      await FundingAllocationModel.collection.updateOne(
        { sessionId: item.allocation.sessionId as string },
        { $setOnInsert: item.allocation },
        { upsert: true }
      );
      await SessionModel.collection.updateOne(
        { publicId: item.allocation.sessionId as string, fundingSourceId: { $exists: false } },
        { $set: item.sessionPatch }
      );
    }
    await WalletFundingModel.collection.updateMany(
      { walletId, fundingSourceId: { $exists: false } },
      {
        $set: {
          fundingSourceId: snapshot.source.sourceId,
          fundingGuarantee: 'network_locked_operator_controlled',
          fundingRiskLabel: 'legacy_operator_vault'
        }
      }
    );
  }
}
