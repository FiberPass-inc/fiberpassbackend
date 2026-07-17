import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config as lumosConfig, helpers } from '@ckb-lumos/lumos';
import { verifyCredential, verifySignature, type SignChallengeResponseData } from '@joyid/ckb';
import { env } from '../config/env.js';
import { assetIdForLegacyCurrency, PAYMENT_CONTRACT_VERSION } from '../domain/payment.js';
import { ApiError } from '../lib/errors.js';
import { fallbackMinorUnits, fromMinorUnits, legacyMinorToAtomicAmount } from '../lib/money.js';
import { AppApiKeyModel, AppModel } from '../models/app.model.js';
import { AuthChallengeModel, AuthSessionModel } from '../models/auth.model.js';
import { StreamTicketModel } from '../models/streamTicket.model.js';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import { FundingAllocationModel, FundingSourceModel } from '../models/fundingSource.model.js';
import { SessionModel } from '../models/session.model.js';
import { WalletFundingModel } from '../models/walletFunding.model.js';
import { WalletModel } from '../models/wallet.model.js';
import { writeAuditLog } from './audit.service.js';
import { listFundingSources } from './fundingSource.service.js';
import { syncWalletFunding } from './walletFunding.service.js';
import type { AuthContext } from '../types/auth.js';
import { ensureWalletForAddress, walletIdFromAddress, type WalletDto } from './session.service.js';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LEGACY_EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
type WalletRecordDto = Awaited<ReturnType<typeof ensureWalletForAddress>>;

export interface AuthChallengeDto {
  challengeId: string;
  message: string;
  expiresAt: string;
  network: string;
}

export interface AuthVerifyInput {
  challengeId: string;
  address: string;
  signature: SignChallengeResponseData;
  legacyEvmAddress?: string;
}

export interface AuthVerifyDto {
  token: string;
  expiresAt: string;
  wallet: WalletDto;
}

export interface StreamTicketDto {
  ticket: string;
  expiresAt: string;
}

function networkConfig() {
  return env.FIBER_NETWORK.toLowerCase().includes('main') ? lumosConfig.MAINNET : lumosConfig.TESTNET;
}

function normalizeAddress(address: string): string {
  const normalized = address.trim().toLowerCase();
  try {
    helpers.parseAddress(normalized, { config: networkConfig() });
    return normalized;
  } catch {
    throw new ApiError(400, 'INVALID_WALLET_ADDRESS', 'JoyID returned an invalid CKB wallet address for this network.');
  }
}

function balanceMinorForWallet(wallet: { balance?: number | null; balanceMinor?: number | null; currency?: string | null }): number {
  return fallbackMinorUnits(wallet.balanceMinor, wallet.balance, wallet.currency ?? 'CKB');
}

function normalizeLegacyEvmAddress(address?: string): string | undefined {
  const normalized = address?.trim().toLowerCase();
  if (!normalized) return undefined;
  return LEGACY_EVM_ADDRESS_PATTERN.test(normalized) ? normalized : undefined;
}

function modifiedCount(result: { modifiedCount?: number }): number {
  return typeof result.modifiedCount === 'number' ? result.modifiedCount : 0;
}

async function syncLegacyPendingFunding(legacyWalletId: string, legacyAddress: string): Promise<void> {
  const pendingFundingCount = await WalletFundingModel.countDocuments({
    walletId: legacyWalletId,
    status: 'pending',
    depositMode: 'vault'
  });
  if (pendingFundingCount === 0) return;

  try {
    await syncWalletFunding(legacyWalletId);
  } catch (error) {
    await writeAuditLog({
      actorWalletId: legacyWalletId,
      actorAddress: legacyAddress,
      action: 'wallet_funding.legacy_sync_failed',
      targetType: 'wallet',
      targetId: legacyWalletId,
      metadata: {
        pendingFundingCount,
        error: error instanceof Error ? error.message : 'Unknown legacy funding sync error'
      }
    });
  }
}

async function normalizeLegacyWalletMoney(legacyWalletId: string): Promise<void> {
  const wallet = await WalletModel.findOne({ walletId: legacyWalletId });
  if (!wallet || wallet.currency !== 'CKB') return;

  const balanceMinor = balanceMinorForWallet(wallet.toObject());
  if (wallet.balanceMinor === balanceMinor && wallet.balance === fromMinorUnits(balanceMinor, wallet.currency)) return;

  wallet.balanceMinor = balanceMinor;
  wallet.balance = fromMinorUnits(balanceMinor, wallet.currency);
  await wallet.save();
}

async function recoverLegacyJoyIdWallet(input: {
  legacyEvmAddress?: string;
  targetWallet: WalletRecordDto;
  targetAddress: string;
}): Promise<WalletRecordDto> {
  const legacyAddress = normalizeLegacyEvmAddress(input.legacyEvmAddress);
  if (!legacyAddress) return input.targetWallet;

  const legacyWalletId = walletIdFromAddress(legacyAddress);
  const targetWalletId = input.targetWallet.walletId;
  if (legacyWalletId === targetWalletId) return input.targetWallet;

  const [legacyWalletExists, fundingCount, sourceCount, allocationCount, sessionCount, chargeAttemptCount, appCount, apiKeyCount] = await Promise.all([
    WalletModel.exists({ walletId: legacyWalletId }),
    WalletFundingModel.countDocuments({ walletId: legacyWalletId }),
    FundingSourceModel.countDocuments({ ownerWalletId: legacyWalletId }),
    FundingAllocationModel.countDocuments({ ownerWalletId: legacyWalletId }),
    SessionModel.countDocuments({ ownerWalletId: legacyWalletId }),
    ChargeAttemptModel.countDocuments({ ownerWalletId: legacyWalletId }),
    AppModel.countDocuments({ ownerWalletId: legacyWalletId }),
    AppApiKeyModel.countDocuments({ ownerWalletId: legacyWalletId })
  ]);

  if (!legacyWalletExists && fundingCount + sourceCount + allocationCount + sessionCount + chargeAttemptCount + appCount + apiKeyCount === 0) {
    return input.targetWallet;
  }

  await syncLegacyPendingFunding(legacyWalletId, legacyAddress);
  await normalizeLegacyWalletMoney(legacyWalletId);

  const claimedLegacyWallet = await WalletModel.findOneAndUpdate(
    { walletId: legacyWalletId, currency: 'CKB', balanceMinor: { $gt: 0 } },
    { $set: { connected: false, balance: 0, balanceMinor: 0 } },
    { new: false }
  ).lean();

  const recoveredBalanceMinor = claimedLegacyWallet ? balanceMinorForWallet(claimedLegacyWallet) : 0;
  const recoveredBalance = fromMinorUnits(recoveredBalanceMinor, 'CKB');

  if (recoveredBalanceMinor > 0) {
    await WalletModel.updateOne(
      { walletId: targetWalletId },
      {
        $set: { connected: true, address: input.targetAddress, currency: 'CKB' },
        $inc: { balanceMinor: recoveredBalanceMinor, balance: recoveredBalance }
      }
    );
  } else {
    await WalletModel.updateOne(
      { walletId: targetWalletId },
      { $set: { connected: true, address: input.targetAddress, currency: 'CKB' } }
    );
  }

  const [fundingResult, sourceResult, allocationResult, sessionResult, chargeAttemptResult, appResult, apiKeyResult, authSessionResult] = await Promise.all([
    WalletFundingModel.updateMany(
      { walletId: legacyWalletId, status: 'confirmed' },
      { $set: { walletId: targetWalletId, walletAddress: input.targetAddress } }
    ),
    FundingSourceModel.updateMany({ ownerWalletId: legacyWalletId }, { $set: { ownerWalletId: targetWalletId } }),
    FundingAllocationModel.updateMany({ ownerWalletId: legacyWalletId }, { $set: { ownerWalletId: targetWalletId } }),
    SessionModel.updateMany({ ownerWalletId: legacyWalletId }, { $set: { ownerWalletId: targetWalletId } }),
    ChargeAttemptModel.updateMany({ ownerWalletId: legacyWalletId }, { $set: { ownerWalletId: targetWalletId } }),
    AppModel.updateMany({ ownerWalletId: legacyWalletId }, { $set: { ownerWalletId: targetWalletId } }),
    AppApiKeyModel.updateMany({ ownerWalletId: legacyWalletId }, { $set: { ownerWalletId: targetWalletId } }),
    AuthSessionModel.updateMany({ walletId: legacyWalletId }, { $set: { walletId: targetWalletId, address: input.targetAddress } })
  ]);

  await WalletModel.updateOne({ walletId: legacyWalletId }, { $set: { connected: false } });

  const movedRecords = {
    funding: modifiedCount(fundingResult),
    fundingSources: modifiedCount(sourceResult),
    fundingAllocations: modifiedCount(allocationResult),
    sessions: modifiedCount(sessionResult),
    chargeAttempts: modifiedCount(chargeAttemptResult),
    apps: modifiedCount(appResult),
    apiKeys: modifiedCount(apiKeyResult),
    authSessions: modifiedCount(authSessionResult)
  };
  const movedRecordCount = Object.values(movedRecords).reduce((total, count) => total + count, 0);

  if (recoveredBalanceMinor > 0 || movedRecordCount > 0) {
    await writeAuditLog({
      actorWalletId: targetWalletId,
      actorAddress: input.targetAddress,
      action: 'wallet.legacy_identity_recovered',
      targetType: 'wallet',
      targetId: targetWalletId,
      metadata: {
        legacyWalletId,
        legacyAddress,
        recoveredBalance,
        recoveredBalanceMinor,
        movedRecords
      }
    });
  }

  const currentTargetWallet = await WalletModel.findOne({ walletId: targetWalletId });
  return currentTargetWallet ? currentTargetWallet.toObject() : input.targetWallet;
}

async function walletDto(input: { walletId: string; connected?: boolean; address: string; balance: number; balanceMinor?: number | null; currency: string }): Promise<WalletDto> {
  const balanceMinor = balanceMinorForWallet(input);
  return {
    contractVersion: PAYMENT_CONTRACT_VERSION,
    connected: input.connected ?? true,
    address: input.address,
    authProvider: 'joyid',
    addressType: 'ckb',
    balance: input.balance,
    balanceMinor,
    balanceAtomic: legacyMinorToAtomicAmount(balanceMinor),
    currency: input.currency,
    assetId: assetIdForLegacyCurrency(input.currency),
    balanceSource: 'legacy_compatibility_projection',
    balanceGuarantee: 'authorization_only',
    fundingSources: await listFundingSources(input.walletId)
  };
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function buildChallengeMessage(input: { address?: string; nonce: string; issuedAt: Date; expiresAt: Date }): string {
  return [
    'FiberPass JoyID Login',
    '',
    'Approve this signature to authenticate with FiberPass.',
    `Wallet: ${input.address ?? 'JoyID wallet'}`,
    `Fiber Network: ${env.FIBER_NETWORK}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt.toISOString()}`,
    `Expires At: ${input.expiresAt.toISOString()}`
  ].join('\n');
}

export async function createAuthChallenge(address?: string): Promise<AuthChallengeDto> {
  const normalizedAddress = address ? normalizeAddress(address) : undefined;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + CHALLENGE_TTL_MS);
  const nonce = randomBytes(16).toString('hex');
  const message = buildChallengeMessage({ address: normalizedAddress, nonce, issuedAt, expiresAt });
  const challengeId = randomUUID();

  await AuthChallengeModel.create({
    challengeId,
    address: normalizedAddress,
    message,
    nonce,
    expiresAt
  });

  return {
    challengeId,
    message,
    expiresAt: expiresAt.toISOString(),
    network: env.FIBER_NETWORK
  };
}

export async function verifyAuthChallenge(input: AuthVerifyInput): Promise<AuthVerifyDto> {
  const normalizedAddress = normalizeAddress(input.address);
  const challenge = await AuthChallengeModel.findOne({ challengeId: input.challengeId });

  if (!challenge) {
    throw new ApiError(404, 'AUTH_CHALLENGE_NOT_FOUND', 'Login challenge was not found or has expired.');
  }

  if (challenge.consumedAt) {
    throw new ApiError(409, 'AUTH_CHALLENGE_USED', 'Login challenge has already been used.');
  }

  if (challenge.expiresAt.getTime() <= Date.now()) {
    throw new ApiError(410, 'AUTH_CHALLENGE_EXPIRED', 'Login challenge has expired.');
  }

  if (challenge.address && normalizeAddress(challenge.address) !== normalizedAddress) {
    throw new ApiError(401, 'AUTH_ADDRESS_MISMATCH', 'Signed wallet address does not match the requested JoyID address.');
  }

  if (input.signature.challenge !== challenge.message) {
    throw new ApiError(401, 'AUTH_CHALLENGE_MISMATCH', 'JoyID signed challenge does not match the active FiberPass login challenge.');
  }

  const signatureValid = await verifySignature(input.signature);
  if (!signatureValid) {
    throw new ApiError(401, 'AUTH_SIGNATURE_INVALID', 'JoyID CKB signature could not be verified.');
  }

  const credentialValid = await verifyCredential({
    pubkey: input.signature.pubkey,
    address: normalizedAddress,
    keyType: input.signature.keyType,
    alg: input.signature.alg
  }, env.JOYID_SERVER_URL);
  if (!credentialValid) {
    throw new ApiError(401, 'AUTH_CREDENTIAL_INVALID', 'JoyID credential is not registered for the connected CKB address.');
  }

  challenge.consumedAt = new Date();
  await challenge.save();

  let wallet = await recoverLegacyJoyIdWallet({
    legacyEvmAddress: input.legacyEvmAddress,
    targetWallet: await ensureWalletForAddress(normalizedAddress),
    targetAddress: normalizedAddress
  });

  try {
    await syncWalletFunding(wallet.walletId);
    const refreshedWallet = await WalletModel.findOne({ walletId: wallet.walletId });
    if (refreshedWallet) wallet = refreshedWallet.toObject();
  } catch (error) {
    await writeAuditLog({
      actorWalletId: wallet.walletId,
      actorAddress: normalizedAddress,
      action: 'wallet_funding.login_sync_failed',
      targetType: 'wallet',
      targetId: wallet.walletId,
      metadata: {
        error: error instanceof Error ? error.message : 'Unknown funding sync error'
      }
    });
  }

  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await AuthSessionModel.create({
    tokenHash: tokenHash(token),
    walletId: wallet.walletId,
    address: normalizedAddress,
    expiresAt
  });

  await writeAuditLog({
    actorWalletId: wallet.walletId,
    actorAddress: normalizedAddress,
    action: 'auth.login',
    targetType: 'wallet',
    targetId: wallet.walletId,
    metadata: { challengeId: input.challengeId }
  });

  return {
    token,
    expiresAt: expiresAt.toISOString(),
    wallet: await walletDto({
      walletId: wallet.walletId,
      connected: true,
      address: normalizedAddress,
      balance: wallet.balance,
      balanceMinor: wallet.balanceMinor,
      currency: wallet.currency
    })
  };
}

export async function getAuthContextFromToken(token: string): Promise<AuthContext> {
  const session = await AuthSessionModel.findOne({
    tokenHash: tokenHash(token),
    expiresAt: { $gt: new Date() }
  }).lean();

  if (!session) {
    throw new ApiError(401, 'AUTH_SESSION_INVALID', 'JoyID session is invalid or expired.');
  }

  return {
    walletId: session.walletId,
    address: session.address
  };
}

export async function createStreamTicket(auth: AuthContext): Promise<StreamTicketDto> {
  const ticket = randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + env.STREAM_TICKET_TTL_SECONDS * 1000);
  await StreamTicketModel.create({
    tokenHash: tokenHash(ticket),
    walletId: auth.walletId,
    address: auth.address,
    expiresAt
  });
  return { ticket, expiresAt: expiresAt.toISOString() };
}

export async function getAuthContextFromStreamTicket(ticket: string): Promise<AuthContext> {
  const record = await StreamTicketModel.findOne({
    tokenHash: tokenHash(ticket),
    expiresAt: { $gt: new Date() }
  }).lean();
  if (!record) {
    throw new ApiError(401, 'STREAM_TICKET_INVALID', 'Live-update ticket is invalid or expired.');
  }
  return { walletId: record.walletId, address: record.address };
}

export async function revokeAuthToken(token: string): Promise<void> {
  const session = await AuthSessionModel.findOneAndDelete({ tokenHash: tokenHash(token) });
  if (session) {
    await StreamTicketModel.deleteMany({ walletId: session.walletId });
    await writeAuditLog({
      actorWalletId: session.walletId,
      actorAddress: session.address,
      action: 'auth.logout',
      targetType: 'wallet',
      targetId: session.walletId
    });
  }
}

export async function getWalletForAuthContext(auth: AuthContext): Promise<{ wallet: WalletDto }> {
  const wallet = await ensureWalletForAddress(auth.address);
  return {
    wallet: await walletDto({
      walletId: wallet.walletId,
      connected: true,
      address: wallet.address,
      balance: wallet.balance,
      balanceMinor: wallet.balanceMinor,
      currency: wallet.currency
    })
  };
}
