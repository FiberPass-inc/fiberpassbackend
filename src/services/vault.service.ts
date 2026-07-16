import { config, helpers, utils, type Script } from '@ckb-lumos/lumos';
import { env } from '../config/env.js';

export type VaultHashType = 'data' | 'type' | 'data1' | 'data2';
export type VaultOwnerLockHashSource = 'wallet-address' | 'explicit-lock-hash' | 'legacy-wallet-id-derived';

export interface DerivedVaultDto {
  address: string;
  scriptHash: string;
  script: {
    codeHash: string;
    hashType: VaultHashType;
    args: string;
  };
  accountIdHash: string;
  vaultIdHash: string;
  ownerLockHash: string;
  ownerLockHashSource: VaultOwnerLockHashSource;
  operatorLockHash: string;
}

export interface VaultRuntimeConfigDto {
  configured: boolean;
  network: string;
  codeHash: string;
  hashType: VaultHashType;
  operatorLockHash: string;
}

export interface VaultOwnerReclaimHandoffDto {
  network: string;
  vaultAddress: string;
  vaultScriptHash: string;
  vaultScript: DerivedVaultDto['script'];
  ownerAddress: string;
  ownerLock: Script;
  ownerLockHash: string;
  vaultWitnessLock: '0x00';
  requiresOwnerAuthInput: true;
}

const SCRIPT_VERSION = 1;

function isHex(value: string, bytes?: number): boolean {
  const pattern = bytes == null ? /^0x[0-9a-fA-F]+$/ : new RegExp('^0x[0-9a-fA-F]{' + bytes * 2 + '}$');
  return pattern.test(value);
}

function stripHex(value: string): string {
  return value.startsWith('0x') ? value.slice(2) : value;
}

function ckbHash(value: string): string {
  return utils.ckbHash(Buffer.from(value));
}

function concatHex(...values: string[]): string {
  return '0x' + values.map(stripHex).join('');
}

function byteHex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

function networkConfig() {
  return env.FIBER_NETWORK.toLowerCase().includes('main') ? config.MAINNET : config.TESTNET;
}

function hashType(): VaultHashType {
  return env.FIBERPASS_VAULT_HASH_TYPE as VaultHashType;
}

export function getVaultRuntimeConfig(): VaultRuntimeConfigDto {
  const codeHash = env.FIBERPASS_VAULT_CODE_HASH;
  const operatorLockHash = env.FIBERPASS_OPERATOR_LOCK_HASH;
  const configured = isHex(codeHash, 32) && isHex(operatorLockHash, 32);

  return {
    configured,
    network: env.FIBER_NETWORK,
    codeHash,
    hashType: hashType(),
    operatorLockHash
  };
}

export function deriveAccountIdHash(walletId: string): string {
  return ckbHash('fiberpass:account:' + walletId);
}

export function deriveWalletOwnerLockHash(walletId: string): string {
  return ckbHash('fiberpass:owner:' + walletId);
}

export function ownerLockHashFromAddress(walletAddress: string): string {
  const ownerLock = helpers.parseAddress(walletAddress, { config: networkConfig() });
  return utils.computeScriptHash(ownerLock);
}

export function deriveVaultIdHash(accountIdHash: string): string {
  return ckbHash('fiberpass:vault:' + accountIdHash);
}


export function minimalVaultCellCapacityShannons(script: DerivedVaultDto['script']): number {
  const cell = {
    cellOutput: {
      capacity: '0x0',
      lock: script,
      type: undefined
    },
    data: '0x'
  } as Parameters<typeof helpers.minimalCellCapacity>[0];
  const capacity = Number(helpers.minimalCellCapacity(cell));
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error('Unable to calculate safe minimum vault cell capacity.');
  }
  return capacity;
}

function deriveVaultWithOwner(input: {
  walletId: string;
  ownerLockHash: string;
  ownerLockHashSource: VaultOwnerLockHashSource;
}): DerivedVaultDto | null {
  const runtime = getVaultRuntimeConfig();
  if (!runtime.configured) return null;

  const accountIdHash = deriveAccountIdHash(input.walletId);
  const vaultIdHash = deriveVaultIdHash(accountIdHash);
  const args = concatHex(
    byteHex(SCRIPT_VERSION),
    vaultIdHash,
    input.ownerLockHash,
    runtime.operatorLockHash
  );
  const script = {
    codeHash: runtime.codeHash,
    hashType: runtime.hashType,
    args
  };

  return {
    address: helpers.encodeToAddress(script, { config: networkConfig() }),
    scriptHash: utils.computeScriptHash(script),
    script,
    accountIdHash,
    vaultIdHash,
    ownerLockHash: input.ownerLockHash,
    ownerLockHashSource: input.ownerLockHashSource,
    operatorLockHash: runtime.operatorLockHash
  };
}

export function deriveVaultForWallet(input: {
  walletId: string;
  walletAddress?: string;
  ownerLockHash?: string;
}): DerivedVaultDto | null {
  if (input.ownerLockHash && isHex(input.ownerLockHash, 32)) {
    return deriveVaultWithOwner({
      walletId: input.walletId,
      ownerLockHash: input.ownerLockHash.toLowerCase(),
      ownerLockHashSource: 'explicit-lock-hash'
    });
  }
  if (!input.walletAddress?.trim()) return null;
  return deriveVaultWithOwner({
    walletId: input.walletId,
    ownerLockHash: ownerLockHashFromAddress(input.walletAddress),
    ownerLockHashSource: 'wallet-address'
  });
}

export function deriveLegacyVaultForWallet(walletId: string): DerivedVaultDto | null {
  return deriveVaultWithOwner({
    walletId,
    ownerLockHash: deriveWalletOwnerLockHash(walletId),
    ownerLockHashSource: 'legacy-wallet-id-derived'
  });
}

export function buildVaultOwnerReclaimHandoff(input: {
  walletId: string;
  walletAddress: string;
}): VaultOwnerReclaimHandoffDto | null {
  const vault = deriveVaultForWallet(input);
  if (!vault) return null;
  const ownerLock = helpers.parseAddress(input.walletAddress, { config: networkConfig() });
  const ownerLockHash = utils.computeScriptHash(ownerLock);
  if (ownerLockHash !== vault.ownerLockHash) {
    throw new Error('Vault owner lock hash does not match the authenticated wallet address.');
  }
  return {
    network: env.FIBER_NETWORK,
    vaultAddress: vault.address,
    vaultScriptHash: vault.scriptHash,
    vaultScript: vault.script,
    ownerAddress: input.walletAddress,
    ownerLock,
    ownerLockHash,
    vaultWitnessLock: '0x00',
    requiresOwnerAuthInput: true
  };
}

export function isVaultOwnerReclaimAuthorized(input: {
  vault: Pick<DerivedVaultDto, 'ownerLockHash'>;
  ownerAuthInputLock: Script;
  vaultWitnessLock: string;
}): boolean {
  return input.vaultWitnessLock.toLowerCase() === '0x00'
    && utils.computeScriptHash(input.ownerAuthInputLock) === input.vault.ownerLockHash;
}
