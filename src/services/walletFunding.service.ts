import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { liveEvents } from '../lib/liveEvents.js';
import { fromMinorUnits, toMinorUnits } from '../lib/money.js';
import { WalletFundingModel, type WalletFundingRecord } from '../models/walletFunding.model.js';
import { WalletModel } from '../models/wallet.model.js';
import { getSessionsOverview, type SessionsOverviewDto } from './session.service.js';
import { writeAuditLog } from './audit.service.js';
import { deriveVaultForWallet, getVaultRuntimeConfig, type DerivedVaultDto } from './vault.service.js';

const FUNDING_CURRENCY = 'USDC';
const MIN_FUNDING_MINOR = toMinorUnits('0.01', FUNDING_CURRENCY);
const MAX_FUNDING_MINOR = toMinorUnits('100000', FUNDING_CURRENCY);

export interface WalletFundingConfigDto {
  currency: string;
  network: string;
  depositMode: 'vault' | 'treasury';
  depositAddress: string;
  configured: boolean;
  vault?: {
    configured: boolean;
    address?: string;
    scriptHash?: string;
    ownerLockHashSource?: string;
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
  status: WalletFundingRecord['status'];
  createdAt: string;
  confirmedAt?: string;
}

export interface WalletFundingOverviewDto {
  config: WalletFundingConfigDto;
  requests: WalletFundingRequestDto[];
}

function newFundingId(): string {
  return 'fp_fund_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

function fundingMemo(walletId: string, fundingId: string): string {
  return ['fiberpass', fundingId, walletId.slice(0, 12)].join(':');
}

function getFundingConfig(walletId?: string): WalletFundingConfigDto {
  const vault = walletId ? deriveVaultForWallet({ walletId }) : null;
  const vaultRuntime = getVaultRuntimeConfig();
  const depositAddress = vault?.address ?? env.FIBERPASS_TREASURY_ADDRESS;
  const depositMode = vault ? 'vault' : 'treasury';

  return {
    currency: FUNDING_CURRENCY,
    network: env.FIBER_NETWORK,
    depositMode,
    depositAddress,
    configured: Boolean(depositAddress),
    vault: {
      configured: vaultRuntime.configured,
      address: vault?.address,
      scriptHash: vault?.scriptHash,
      ownerLockHashSource: vault?.ownerLockHashSource
    }
  };
}

function requireFundingConfig(walletId: string): WalletFundingConfigDto & { vaultDetails?: DerivedVaultDto } {
  const vaultDetails = deriveVaultForWallet({ walletId }) ?? undefined;
  const config = getFundingConfig(walletId);
  if (!config.configured) {
    throw new ApiError(503, 'FUNDING_ADDRESS_NOT_CONFIGURED', 'Wallet funding is unavailable until FiberPass vault deployment env or FIBERPASS_TREASURY_ADDRESS is configured on the backend.');
  }
  return { ...config, vaultDetails };
}

function toFundingDto(record: WalletFundingRecord & { createdAt?: Date; confirmedAt?: Date | null }): WalletFundingRequestDto {
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
    status: record.status,
    createdAt: (record.createdAt ?? new Date()).toISOString(),
    confirmedAt: record.confirmedAt?.toISOString()
  };
}

function validateFundingAmount(amount: number): number {
  const amountMinor = toMinorUnits(String(amount), FUNDING_CURRENCY);
  if (amountMinor < MIN_FUNDING_MINOR || amountMinor > MAX_FUNDING_MINOR) {
    throw new ApiError(400, 'FUNDING_AMOUNT_OUT_OF_RANGE', 'Funding amount must be between $0.01 and $100,000.00.');
  }
  return amountMinor;
}

function normalizeProofId(proofId: string): string {
  return proofId.trim();
}

async function getWalletOrThrow(walletId: string) {
  const wallet = await WalletModel.findOne({ walletId });
  if (!wallet) {
    throw new ApiError(404, 'WALLET_NOT_FOUND', 'Connect with JoyID before loading wallet funds.');
  }
  return wallet;
}

export async function listWalletFunding(walletId: string): Promise<WalletFundingOverviewDto> {
  const requests = await WalletFundingModel.find({ walletId }).sort({ createdAt: -1 }).limit(20).lean<(WalletFundingRecord & { createdAt?: Date; confirmedAt?: Date })[]>();
  return {
    config: getFundingConfig(walletId),
    requests: requests.map(toFundingDto)
  };
}

export async function createWalletFundingRequest(walletId: string, amount: number): Promise<WalletFundingRequestDto> {
  const wallet = await getWalletOrThrow(walletId);
  const amountMinor = validateFundingAmount(amount);
  const config = requireFundingConfig(walletId);
  const vaultDetails = config.vaultDetails;
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

export async function confirmWalletFundingRequest(walletId: string, fundingId: string, proofId: string): Promise<SessionsOverviewDto> {
  const normalizedProofId = normalizeProofId(proofId);
  const funding = await WalletFundingModel.findOne({ walletId, fundingId });
  if (!funding) {
    throw new ApiError(404, 'FUNDING_REQUEST_NOT_FOUND', 'Wallet funding request was not found.');
  }

  if (funding.status === 'confirmed') {
    throw new ApiError(409, 'FUNDING_ALREADY_CONFIRMED', 'This wallet funding request is already confirmed.');
  }

  const proofExists = await WalletFundingModel.exists({ proofId: normalizedProofId, status: 'confirmed' });
  if (proofExists) {
    throw new ApiError(409, 'FUNDING_PROOF_ALREADY_USED', 'This funding proof has already been recorded.');
  }

  funding.status = 'confirmed';
  funding.proofId = normalizedProofId;
  funding.confirmedAt = new Date();
  await funding.save();

  await WalletModel.updateOne(
    { walletId },
    {
      $inc: {
        balanceMinor: funding.amountMinor,
        balance: fromMinorUnits(funding.amountMinor, funding.currency)
      }
    }
  );

  await writeAuditLog({
    actorWalletId: walletId,
    actorAddress: funding.walletAddress,
    action: 'wallet_funding.confirmed',
    targetType: 'wallet_funding',
    targetId: fundingId,
    metadata: { amountMinor: funding.amountMinor, currency: funding.currency, proofId: normalizedProofId }
  });

  const overview = await getSessionsOverview(walletId);
  liveEvents.publish('overview:' + walletId, overview);
  return overview;
}
