import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { liveEvents } from '../lib/liveEvents.js';
import { fromMinorUnits, toMinorUnits } from '../lib/money.js';
import { ckbTransactionExplorerUrl } from '../lib/ckbExplorer.js';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import { SessionModel } from '../models/session.model.js';
import { WalletFundingModel, type WalletFundingRecord } from '../models/walletFunding.model.js';
import { WalletModel, type WalletRecord } from '../models/wallet.model.js';
import { getSessionsOverview, type SessionsOverviewDto } from './session.service.js';
import { writeAuditLog } from './audit.service.js';
import {
  findVaultDepositInTransaction,
  getCkbBalanceForAddress,
  getCkbBalanceForLock,
  listCkbLockActivity,
  listLiveVaultCells,
  normalizeCkbTxHash,
  transactionSpendsLock,
  type CkbDepositOutput,
  type CkbLiveCell,
  type CkbLockActivity
} from './ckbChain.service.js';
import { buildVaultOwnerReclaimHandoff, deriveLegacyVaultForWallet, deriveVaultForWallet, getVaultRuntimeConfig, minimalVaultCellCapacityShannons, type DerivedVaultDto, type VaultOwnerReclaimHandoffDto } from './vault.service.js';

const FUNDING_CURRENCY = 'CKB';
const MIN_FUNDING_MINOR = toMinorUnits('138', FUNDING_CURRENCY);
const MAX_FUNDING_MINOR = toMinorUnits('100000', FUNDING_CURRENCY);
const MAX_WALLET_ACTIVITY = 80;
type WalletFundingDocument = WalletFundingRecord & { save: () => Promise<unknown> };

type ActivitySource = 'funding' | 'chain' | 'payment' | 'session';

type ChainBalanceStatus = 'ok' | 'unavailable' | 'not_configured';

export interface WalletFundingConfigDto {
  currency: string;
  network: string;
  depositMode: 'vault' | 'treasury';
  depositAddress: string;
  configured: boolean;
  minAmount: number;
  minAmountMinor: number;
  maxAmount: number;
  maxAmountMinor: number;
  chain: {
    rpcConfigured: boolean;
    indexerConfigured: boolean;
  };
  vault?: {
    configured: boolean;
    address?: string;
    scriptHash?: string;
    ownerLockHashSource?: string;
    ownerLockHash?: string;
    legacyRecovery?: {
      address: string;
      scriptHash: string;
      mode: 'operator-migration-required';
    };
  };
}

export interface WalletFundingRequestDto {
  id: string;
  walletAddress: string;
  amount: number;
  amountMinor: number;
  currency: string;
  network: string;
  depositMode?: string;
  depositAddress: string;
  vaultScriptHash?: string;
  vaultScriptArgs?: string;
  vaultOwnerLockHash?: string;
  vaultOwnerLockHashSource?: string;
  vaultAccountIdHash?: string;
  memo: string;
  proofId?: string;
  chainTxHash?: string;
  chainOutputIndex?: string;
  chainOutPoint?: string;
  chainBlockHash?: string;
  chainBlockNumber?: string;
  chainCapacityShannons?: number;
  chainConfirmedAt?: string;
  status: WalletFundingRecord['status'];
  createdAt: string;
  confirmedAt?: string;
}

export interface WalletChainBalanceDto {
  amount: number;
  amountMinor: number;
  currency: string;
  liveCellCount: number;
  status: ChainBalanceStatus;
  error?: string;
}

export interface WalletChainActivityDto {
  id: string;
  source: ActivitySource;
  type: string;
  label: string;
  status?: string;
  amount?: number;
  amountMinor?: number;
  currency: string;
  txHash?: string;
  explorerUrl?: string;
  timestamp?: string;
  blockNumber?: string;
  direction?: 'input' | 'output' | 'unknown';
  referenceId?: string;
  details?: string;
}

export interface WalletChainStateDto {
  network: string;
  currency: string;
  wallet: WalletChainBalanceDto & { address: string };
  vault?: (WalletChainBalanceDto & { address: string; scriptHash?: string });
  activities: WalletChainActivityDto[];
  lastSyncedAt: string;
}

export interface WalletFundingOverviewDto {
  config: WalletFundingConfigDto;
  requests: WalletFundingRequestDto[];
  chain: WalletChainStateDto;
  activities: WalletChainActivityDto[];
  recoveredDeposits?: number;
}

export interface WalletVaultRecoveryDto {
  current: VaultOwnerReclaimHandoffDto;
  legacy?: {
    address: string;
    scriptHash: string;
    mode: 'operator-migration-required';
    destinationAddress: string;
  };
}

function newFundingId(): string {
  return 'fp_fund_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

function fundingMemo(walletId: string, fundingId: string): string {
  return ['fiberpass', fundingId, walletId.slice(0, 12)].join(':');
}

function recoveredFundingMemo(cell: CkbLiveCell): string {
  return 'fiberpass:recovered:' + cell.txHash.slice(2, 14) + ':' + cell.outputIndex;
}

function minimumFundingMinor(vault?: DerivedVaultDto | null): number {
  return Math.max(MIN_FUNDING_MINOR, vault ? minimalVaultCellCapacityShannons(vault.script) : MIN_FUNDING_MINOR);
}

function getFundingConfig(wallet?: Pick<WalletRecord, 'walletId' | 'address'>): WalletFundingConfigDto {
  const vault = wallet ? deriveVaultForWallet({ walletId: wallet.walletId, walletAddress: wallet.address }) : null;
  const legacyVault = wallet ? deriveLegacyVaultForWallet(wallet.walletId) : null;
  const vaultRuntime = getVaultRuntimeConfig();
  const depositAddress = vault?.address ?? env.FIBERPASS_TREASURY_ADDRESS;
  const depositMode = vault ? 'vault' : 'treasury';
  const minAmountMinor = minimumFundingMinor(vault);

  return {
    currency: FUNDING_CURRENCY,
    network: env.FIBER_NETWORK,
    depositMode,
    depositAddress,
    configured: Boolean(depositAddress),
    minAmount: fromMinorUnits(minAmountMinor, FUNDING_CURRENCY),
    minAmountMinor,
    maxAmount: fromMinorUnits(MAX_FUNDING_MINOR, FUNDING_CURRENCY),
    maxAmountMinor: MAX_FUNDING_MINOR,
    chain: {
      rpcConfigured: Boolean(env.CKB_TESTNET_RPC_URL),
      indexerConfigured: Boolean(env.CKB_TESTNET_INDEXER_URL)
    },
    vault: {
      configured: vaultRuntime.configured,
      address: vault?.address,
      scriptHash: vault?.scriptHash,
      ownerLockHashSource: vault?.ownerLockHashSource,
      ownerLockHash: vault?.ownerLockHash,
      legacyRecovery: legacyVault && legacyVault.scriptHash !== vault?.scriptHash
        ? {
            address: legacyVault.address,
            scriptHash: legacyVault.scriptHash,
            mode: 'operator-migration-required'
          }
        : undefined
    }
  };
}

function requireFundingConfig(wallet: Pick<WalletRecord, 'walletId' | 'address'>): WalletFundingConfigDto & { vaultDetails?: DerivedVaultDto } {
  const vaultDetails = deriveVaultForWallet({ walletId: wallet.walletId, walletAddress: wallet.address }) ?? undefined;
  const config = getFundingConfig(wallet);
  if (!config.configured) {
    throw new ApiError(503, 'FUNDING_ADDRESS_NOT_CONFIGURED', 'Wallet funding is unavailable until FiberPass vault deployment env is configured on the backend.');
  }
  if (config.depositMode !== 'vault' || !vaultDetails) {
    throw new ApiError(503, 'VAULT_FUNDING_NOT_CONFIGURED', 'Beta funding requires the deployed CKB vault configuration. Treasury/manual funding is disabled.');
  }
  return { ...config, vaultDetails };
}

function toFundingDto(record: WalletFundingRecord & { createdAt?: Date; confirmedAt?: Date | null; chainConfirmedAt?: Date | null }): WalletFundingRequestDto {
  return {
    id: record.fundingId,
    walletAddress: record.walletAddress,
    amount: fromMinorUnits(record.amountMinor, record.currency),
    amountMinor: record.amountMinor,
    currency: record.currency,
    network: record.network,
    depositMode: record.depositMode ?? 'treasury',
    depositAddress: record.depositAddress,
    vaultScriptHash: record.vaultScriptHash ?? undefined,
    vaultScriptArgs: record.vaultScriptArgs ?? undefined,
    vaultOwnerLockHash: record.vaultOwnerLockHash ?? undefined,
    vaultOwnerLockHashSource: record.vaultOwnerLockHashSource ?? undefined,
    vaultAccountIdHash: record.vaultAccountIdHash ?? undefined,
    memo: record.memo,
    proofId: record.proofId ?? undefined,
    chainTxHash: record.chainTxHash ?? undefined,
    chainOutputIndex: record.chainOutputIndex ?? undefined,
    chainOutPoint: record.chainOutPoint ?? undefined,
    chainBlockHash: record.chainBlockHash ?? undefined,
    chainBlockNumber: record.chainBlockNumber ?? undefined,
    chainCapacityShannons: record.chainCapacityShannons ?? undefined,
    chainConfirmedAt: record.chainConfirmedAt?.toISOString(),
    status: record.status,
    createdAt: (record.createdAt ?? new Date()).toISOString(),
    confirmedAt: record.confirmedAt?.toISOString()
  };
}

function validateFundingAmount(amount: number, minFundingMinor: number): number {
  const amountMinor = toMinorUnits(String(amount), FUNDING_CURRENCY);
  if (amountMinor < minFundingMinor || amountMinor > MAX_FUNDING_MINOR) {
    throw new ApiError(400, 'FUNDING_AMOUNT_OUT_OF_RANGE', 'Funding amount must be between ' + fromMinorUnits(minFundingMinor, FUNDING_CURRENCY).toLocaleString('en-US') + ' and 100,000 CKB.');
  }
  return amountMinor;
}

async function getWalletOrThrow(walletId: string) {
  const wallet = await WalletModel.findOne({ walletId });
  if (!wallet) {
    throw new ApiError(404, 'WALLET_NOT_FOUND', 'Connect with JoyID before loading wallet funds.');
  }
  return wallet;
}

async function usedVaultOutPoints(): Promise<Set<string>> {
  const records = await WalletFundingModel.find({
    status: 'confirmed',
    chainOutPoint: { $exists: true, $ne: '' }
  }).select('chainOutPoint').lean<Array<{ chainOutPoint?: string }>>();
  return new Set(records.map((record) => record.chainOutPoint).filter((value): value is string => Boolean(value)));
}

export async function applyConfirmedFunding(input: {
  walletId: string;
  funding: WalletFundingDocument | null;
  deposit: CkbDepositOutput;
  proofId: string;
}): Promise<boolean> {
  const { walletId, funding, deposit, proofId } = input;
  if (!funding) throw new ApiError(404, 'FUNDING_REQUEST_NOT_FOUND', 'Wallet funding request was not found.');
  const now = new Date();
  const creditedMinor = deposit.capacityShannons;
  const amount = fromMinorUnits(creditedMinor, funding.currency);
  let requestedAmountMinor = funding.amountMinor;
  let credited = false;

  try {
    await WalletFundingModel.db.transaction(async (mongoSession) => {
      const current = await WalletFundingModel.findOne({
        walletId,
        fundingId: funding.fundingId
      }).session(mongoSession);
      if (!current) throw new ApiError(404, 'FUNDING_REQUEST_NOT_FOUND', 'Wallet funding request was not found.');
      if (current.status === 'confirmed') {
        if (current.chainOutPoint !== deposit.outPoint || current.proofId !== proofId) {
          throw new ApiError(409, 'FUNDING_ALREADY_CONFIRMED', 'This funding request was confirmed with a different deposit proof.');
        }
        credited = false;
        return;
      }
      requestedAmountMinor = current.amountMinor;

      const confirmed = await WalletFundingModel.findOneAndUpdate(
        { _id: current._id, status: 'pending' },
        {
          $set: {
            status: 'confirmed',
            proofId,
            chainTxHash: deposit.txHash,
            chainOutputIndex: deposit.outputIndex,
            chainOutPoint: deposit.outPoint,
            chainBlockHash: deposit.blockHash,
            chainBlockNumber: deposit.blockNumber,
            chainCapacityShannons: deposit.capacityShannons,
            chainConfirmedAt: now,
            confirmedAt: now,
            amountMinor: creditedMinor,
            amount
          }
        },
        { new: true, session: mongoSession }
      );
      if (!confirmed) throw new ApiError(409, 'FUNDING_TRANSITION_CONFLICT', 'Funding confirmation is already being processed.');

      const walletResult = await WalletModel.updateOne(
        { walletId },
        {
          $set: { currency: FUNDING_CURRENCY },
          $inc: { balanceMinor: creditedMinor, balance: amount }
        },
        { session: mongoSession }
      );
      if (walletResult.matchedCount !== 1) {
        throw new ApiError(404, 'WALLET_NOT_FOUND', 'Connected wallet was not found while crediting funding.');
      }
      credited = true;
    });
  } catch (error) {
    if (error && typeof error === 'object' && (error as { code?: unknown }).code === 11000) {
      throw new ApiError(409, 'FUNDING_OUTPOINT_ALREADY_USED', 'This vault deposit output has already been credited.');
    }
    throw error;
  }

  if (credited) await writeAuditLog({
    actorWalletId: walletId,
    actorAddress: funding.walletAddress,
    action: 'wallet_funding.confirmed',
    targetType: 'wallet_funding',
    targetId: funding.fundingId,
    metadata: {
      amountMinor: creditedMinor,
      requestedAmountMinor,
      currency: funding.currency,
      txHash: deposit.txHash,
      outPoint: deposit.outPoint,
      capacityShannons: deposit.capacityShannons
    }
  });
  return credited;
}

function emptyBalance(status: ChainBalanceStatus, error?: string): WalletChainBalanceDto {
  return {
    amount: 0,
    amountMinor: 0,
    currency: FUNDING_CURRENCY,
    liveCellCount: 0,
    status,
    error
  };
}

function chainActivityToDto(input: { item: CkbLockActivity; label: string; source: ActivitySource }): WalletChainActivityDto {
  return {
    id: input.source + ':tx:' + input.item.txHash,
    source: input.source,
    type: 'chain_transaction',
    label: input.label,
    status: 'committed',
    currency: FUNDING_CURRENCY,
    txHash: input.item.txHash,
    explorerUrl: ckbTransactionExplorerUrl(input.item.txHash, env.FIBER_NETWORK),
    blockNumber: input.item.blockNumber
  };
}

async function getWalletChainState(walletId: string, address: string): Promise<WalletChainStateDto> {
  const vault = deriveVaultForWallet({ walletId, walletAddress: address });
  let walletBalance: WalletChainStateDto['wallet'] = { address, ...emptyBalance(env.CKB_TESTNET_INDEXER_URL ? 'ok' : 'not_configured') };
  let vaultBalance: WalletChainStateDto['vault'];
  const activities: WalletChainActivityDto[] = [];

  if (!env.CKB_TESTNET_INDEXER_URL) {
    return {
      network: env.FIBER_NETWORK,
      currency: FUNDING_CURRENCY,
      wallet: { address, ...emptyBalance('not_configured', 'CKB indexer URL is not configured.') },
      vault: vault ? { address: vault.address, scriptHash: vault.scriptHash, ...emptyBalance('not_configured', 'CKB indexer URL is not configured.') } : undefined,
      activities,
      lastSyncedAt: new Date().toISOString()
    };
  }

  try {
    const balance = await getCkbBalanceForAddress(address);
    walletBalance = {
      address,
      amount: fromMinorUnits(balance.balanceShannons, FUNDING_CURRENCY),
      amountMinor: balance.balanceShannons,
      currency: FUNDING_CURRENCY,
      liveCellCount: balance.liveCellCount,
      status: 'ok'
    };
  } catch (error) {
    walletBalance = { address, ...emptyBalance('unavailable', error instanceof Error ? error.message : 'Could not load JoyID wallet chain balance.') };
  }

  if (vault) {
    try {
      const balance = await getCkbBalanceForLock(vault.script);
      vaultBalance = {
        address: vault.address,
        scriptHash: vault.scriptHash,
        amount: fromMinorUnits(balance.balanceShannons, FUNDING_CURRENCY),
        amountMinor: balance.balanceShannons,
        currency: FUNDING_CURRENCY,
        liveCellCount: balance.liveCellCount,
        status: 'ok'
      };
      const vaultActivity = await listCkbLockActivity({ lock: vault.script, limit: 12 }).catch(() => []);
      activities.push(...vaultActivity.map((item) => chainActivityToDto({ item, label: 'FiberPass vault transaction', source: 'chain' })));
    } catch (error) {
      vaultBalance = { address: vault.address, scriptHash: vault.scriptHash, ...emptyBalance('unavailable', error instanceof Error ? error.message : 'Could not load FiberPass vault chain balance.') };
    }
  }

  return {
    network: env.FIBER_NETWORK,
    currency: FUNDING_CURRENCY,
    wallet: walletBalance,
    vault: vaultBalance,
    activities: dedupeActivities(activities),
    lastSyncedAt: new Date().toISOString()
  };
}

function dedupeActivities(activities: WalletChainActivityDto[]): WalletChainActivityDto[] {
  const seen = new Set<string>();
  const result: WalletChainActivityDto[] = [];
  for (const activity of activities) {
    const key = activity.source === 'chain' && activity.txHash ? activity.source + ':' + activity.txHash : activity.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(activity);
  }
  return result;
}

function activityTime(activity: WalletChainActivityDto): number {
  if (activity.timestamp) {
    const parsed = new Date(activity.timestamp).getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  if (activity.blockNumber) {
    return Number(BigInt(activity.blockNumber));
  }
  return 0;
}

async function buildWalletActivities(walletId: string, chain: WalletChainStateDto): Promise<WalletChainActivityDto[]> {
  const [funding, attempts, sessions] = await Promise.all([
    WalletFundingModel.find({ walletId }).sort({ createdAt: -1 }).limit(50).lean<Array<WalletFundingRecord & { createdAt?: Date; confirmedAt?: Date; chainConfirmedAt?: Date }>>(),
    ChargeAttemptModel.find({ ownerWalletId: walletId }).sort({ createdAt: -1 }).limit(50).lean<Array<{
      attemptId: string;
      sessionId: string;
      amount: number;
      amountMinor?: number | null;
      currency: string;
      type: string;
      status: string;
      proofId?: string | null;
      createdAt?: Date;
    }>>(),
    SessionModel.find({ ownerWalletId: walletId }).sort({ updatedAt: -1 }).limit(25).select('publicId name currency logs createdAt updatedAt').lean<Array<{
      publicId: string;
      name: string;
      currency: string;
      logs?: Array<{ id: string; type: string; timestamp: string; amount: number; amountMinor?: number }>;
      createdAt?: Date;
      updatedAt?: Date;
    }>>()
  ]);

  const knownTxHashes = new Set<string>();
  for (const item of funding) {
    const txHash = item.chainTxHash ?? item.proofId ?? undefined;
    if (txHash) knownTxHashes.add(txHash);
  }
  for (const attempt of attempts) {
    if (attempt.proofId) knownTxHashes.add(attempt.proofId);
  }

  const activities: WalletChainActivityDto[] = chain.activities.filter((activity) => !activity.txHash || !knownTxHashes.has(activity.txHash));
  for (const item of funding) {
    const amountMinor = item.amountMinor;
    const txHash = item.chainTxHash ?? item.proofId ?? undefined;
    activities.push({
      id: 'funding:' + item.fundingId,
      source: 'funding',
      type: 'wallet_funding',
      label: item.status === 'confirmed' ? 'Vault funding confirmed' : 'Vault funding requested',
      status: item.status,
      amount: fromMinorUnits(amountMinor, item.currency),
      amountMinor,
      currency: item.currency,
      txHash,
      explorerUrl: ckbTransactionExplorerUrl(txHash, item.network),
      timestamp: (item.chainConfirmedAt ?? item.confirmedAt ?? item.createdAt ?? new Date()).toISOString(),
      blockNumber: item.chainBlockNumber ?? undefined,
      referenceId: item.fundingId,
      details: item.memo
    });
  }

  for (const attempt of attempts) {
    const amountMinor = attempt.amountMinor ?? toMinorUnits(String(attempt.amount), attempt.currency);
    activities.push({
      id: 'payment:' + attempt.attemptId,
      source: 'payment',
      type: 'payment_attempt',
      label: attempt.type,
      status: attempt.status,
      amount: fromMinorUnits(amountMinor, attempt.currency),
      amountMinor,
      currency: attempt.currency,
      txHash: attempt.proofId ?? undefined,
      explorerUrl: ckbTransactionExplorerUrl(attempt.proofId ?? undefined, env.FIBER_NETWORK),
      timestamp: (attempt.createdAt ?? new Date()).toISOString(),
      referenceId: attempt.sessionId
    });
  }

  for (const session of sessions) {
    for (const log of session.logs ?? []) {
      activities.push({
        id: 'session:' + session.publicId + ':' + log.id,
        source: 'session',
        type: 'session_log',
        label: session.name + ': ' + log.type,
        amount: log.amount,
        amountMinor: log.amountMinor,
        currency: session.currency,
        timestamp: log.timestamp,
        referenceId: session.publicId
      });
    }
  }

  return dedupeActivities(activities)
    .sort((a, b) => activityTime(b) - activityTime(a))
    .slice(0, MAX_WALLET_ACTIVITY);
}

async function buildFundingOverview(walletId: string, recoveredDeposits = 0): Promise<WalletFundingOverviewDto> {
  const wallet = await getWalletOrThrow(walletId);
  const requests = await WalletFundingModel.find({ walletId }).sort({ createdAt: -1 }).limit(50).lean<(WalletFundingRecord & { createdAt?: Date; confirmedAt?: Date; chainConfirmedAt?: Date })[]>();
  const chain = await getWalletChainState(walletId, wallet.address);
  const activities = await buildWalletActivities(walletId, chain);
  return {
    config: getFundingConfig(wallet.toObject()),
    requests: requests.map(toFundingDto),
    chain,
    activities,
    recoveredDeposits
  };
}

async function createRecoveredFundingRecord(input: { wallet: WalletRecord; vault: DerivedVaultDto; cell: CkbLiveCell }): Promise<WalletFundingDocument> {
  const fundingId = newFundingId();
  const record = await WalletFundingModel.create({
    fundingId,
    walletId: input.wallet.walletId,
    walletAddress: input.wallet.address,
    amount: fromMinorUnits(input.cell.capacityShannons, FUNDING_CURRENCY),
    amountMinor: input.cell.capacityShannons,
    currency: FUNDING_CURRENCY,
    network: env.FIBER_NETWORK,
    depositMode: 'vault',
    depositAddress: input.vault.address,
    vaultScriptHash: input.vault.scriptHash,
    vaultScriptArgs: input.vault.script.args,
    vaultOwnerLockHash: input.vault.ownerLockHash,
    vaultOwnerLockHashSource: input.vault.ownerLockHashSource,
    vaultAccountIdHash: input.vault.accountIdHash,
    memo: recoveredFundingMemo(input.cell),
    status: 'pending'
  });

  await writeAuditLog({
    actorWalletId: input.wallet.walletId,
    actorAddress: input.wallet.address,
    action: 'wallet_funding.recovered_requested',
    targetType: 'wallet_funding',
    targetId: fundingId,
    metadata: {
      amountMinor: input.cell.capacityShannons,
      txHash: input.cell.txHash,
      outPoint: input.cell.outPoint,
      vaultScriptHash: input.vault.scriptHash
    }
  });

  return record as WalletFundingDocument;
}

export async function listWalletFunding(walletId: string): Promise<WalletFundingOverviewDto> {
  return buildFundingOverview(walletId);
}

export async function getWalletVaultRecovery(walletId: string): Promise<WalletVaultRecoveryDto> {
  const wallet = await getWalletOrThrow(walletId);
  const current = buildVaultOwnerReclaimHandoff({ walletId, walletAddress: wallet.address });
  if (!current) {
    throw new ApiError(503, 'USER_VAULT_NOT_CONFIGURED', 'This wallet does not have a configured FiberPass vault.');
  }
  const legacy = deriveLegacyVaultForWallet(walletId);
  return {
    current,
    legacy: legacy && legacy.scriptHash !== current.vaultScriptHash
      ? {
          address: legacy.address,
          scriptHash: legacy.scriptHash,
          mode: 'operator-migration-required',
          destinationAddress: current.vaultAddress
        }
      : undefined
  };
}

export async function createWalletFundingRequest(walletId: string, amount: number): Promise<WalletFundingRequestDto> {
  const wallet = await getWalletOrThrow(walletId);
  const config = requireFundingConfig(wallet.toObject());
  const vaultDetails = config.vaultDetails;
  const amountMinor = validateFundingAmount(amount, config.minAmountMinor);
  const fundingId = newFundingId();
  const record = await WalletFundingModel.create({
    fundingId,
    walletId,
    walletAddress: wallet.address,
    amount: fromMinorUnits(amountMinor, FUNDING_CURRENCY),
    amountMinor,
    currency: FUNDING_CURRENCY,
    network: config.network,
    depositMode: config.depositMode,
    depositAddress: config.depositAddress,
    vaultScriptHash: vaultDetails?.scriptHash,
    vaultScriptArgs: vaultDetails?.script.args,
    vaultOwnerLockHash: vaultDetails?.ownerLockHash,
    vaultOwnerLockHashSource: vaultDetails?.ownerLockHashSource,
    vaultAccountIdHash: vaultDetails?.accountIdHash,
    memo: fundingMemo(walletId, fundingId),
    status: 'pending'
  });

  await WalletModel.updateOne({ walletId }, { $set: { currency: FUNDING_CURRENCY } });

  await writeAuditLog({
    actorWalletId: walletId,
    actorAddress: wallet.address,
    action: 'wallet_funding.requested',
    targetType: 'wallet_funding',
    targetId: fundingId,
    metadata: { amountMinor, currency: FUNDING_CURRENCY, network: config.network, depositMode: config.depositMode, vaultScriptHash: vaultDetails?.scriptHash }
  });

  return toFundingDto(record.toObject());
}

export async function syncWalletFunding(walletId: string): Promise<WalletFundingOverviewDto> {
  const wallet = await getWalletOrThrow(walletId);
  const vault = deriveVaultForWallet({ walletId, walletAddress: wallet.address });
  let recoveredDeposits = 0;

  if (!vault) {
    return buildFundingOverview(walletId);
  }

  const [pendingRequests, liveCells, used, confirmedVaultFundingCount] = await Promise.all([
    WalletFundingModel.find({ walletId, status: 'pending', depositMode: 'vault' }).sort({ createdAt: 1 }),
    listLiveVaultCells({ lock: vault.script, limit: 500 }),
    usedVaultOutPoints(),
    WalletFundingModel.countDocuments({ walletId, status: 'confirmed', depositMode: 'vault', vaultScriptHash: vault.scriptHash })
  ]);
  const recoverCurrentVaultState = confirmedVaultFundingCount === 0 && pendingRequests.length === 0;

  for (const funding of pendingRequests) {
    if (funding.vaultScriptHash !== vault.scriptHash) continue;
    const cell = liveCells.find((candidate) => !used.has(candidate.outPoint) && candidate.capacityShannons >= funding.amountMinor);
    if (!cell) continue;

    await applyConfirmedFunding({
      walletId,
      funding,
      proofId: cell.txHash,
      deposit: {
        txHash: cell.txHash,
        outputIndex: cell.outputIndex,
        outPoint: cell.outPoint,
        capacityShannons: cell.capacityShannons,
        blockNumber: cell.blockNumber
      }
    });
    used.add(cell.outPoint);
  }

  for (const cell of liveCells) {
    if (used.has(cell.outPoint)) continue;
    const isInternalVaultChange = await transactionSpendsLock({ txHash: cell.txHash, lock: vault.script }).catch(() => true);
    if (isInternalVaultChange && !recoverCurrentVaultState) continue;

    const recovered = await createRecoveredFundingRecord({ wallet: wallet.toObject(), vault, cell });
    await applyConfirmedFunding({
      walletId,
      funding: recovered,
      proofId: cell.txHash,
      deposit: {
        txHash: cell.txHash,
        outputIndex: cell.outputIndex,
        outPoint: cell.outPoint,
        capacityShannons: cell.capacityShannons,
        blockNumber: cell.blockNumber
      }
    });
    used.add(cell.outPoint);
    recoveredDeposits += 1;
  }

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish('overview:' + walletId, overview);
  return buildFundingOverview(walletId, recoveredDeposits);
}

export async function confirmWalletFundingRequest(walletId: string, fundingId: string, proofId: string): Promise<SessionsOverviewDto> {
  const txHash = normalizeCkbTxHash(proofId);
  const funding = await WalletFundingModel.findOne({ walletId, fundingId });
  if (!funding) {
    throw new ApiError(404, 'FUNDING_REQUEST_NOT_FOUND', 'Wallet funding request was not found.');
  }

  if (funding.status === 'confirmed') {
    if (funding.proofId === txHash || funding.chainTxHash === txHash) {
      return getSessionsOverview(walletId);
    }
    throw new ApiError(409, 'FUNDING_ALREADY_CONFIRMED', 'This wallet funding request is already confirmed with another proof.');
  }

  if (funding.depositMode !== 'vault') {
    throw new ApiError(409, 'MANUAL_FUNDING_DISABLED', 'Only CKB vault deposits can be confirmed in beta.');
  }

  const vault = deriveVaultForWallet({ walletId, walletAddress: funding.walletAddress });
  if (!vault || vault.scriptHash !== funding.vaultScriptHash) {
    throw new ApiError(409, 'VAULT_ADDRESS_MISMATCH', 'Funding request vault does not match the connected wallet vault.');
  }

  const proofExists = await WalletFundingModel.exists({ proofId: txHash, status: 'confirmed' });
  if (proofExists) {
    throw new ApiError(409, 'FUNDING_PROOF_ALREADY_USED', 'This CKB transaction hash has already been recorded.');
  }

  const deposit = await findVaultDepositInTransaction({
    txHash,
    expectedLock: vault.script,
    minimumCapacityShannons: funding.amountMinor,
    usedOutPoints: await usedVaultOutPoints()
  });

  await applyConfirmedFunding({ walletId, funding, deposit, proofId: txHash });

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish('overview:' + walletId, overview);
  return overview;
}
