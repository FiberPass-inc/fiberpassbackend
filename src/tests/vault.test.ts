import assert from 'node:assert/strict';

process.env.FIBER_NETWORK = 'testnet';
process.env.FIBERPASS_VAULT_CODE_HASH = '0x' + '11'.repeat(32);
process.env.FIBERPASS_VAULT_HASH_TYPE = 'type';
process.env.FIBERPASS_OPERATOR_LOCK_HASH = '0x' + '22'.repeat(32);

const {
  buildVaultOwnerReclaimHandoff,
  deriveLegacyVaultForWallet,
  deriveVaultForWallet,
  getVaultRuntimeConfig,
  isVaultOwnerReclaimAuthorized,
  minimalVaultCellCapacityShannons,
  ownerLockHashFromAddress
} = await import('../services/vault.service.js');

const runtime = getVaultRuntimeConfig();
assert.equal(runtime.configured, true);
assert.equal(runtime.network, 'testnet');

const walletAddress = 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl';
const firstVault = deriveVaultForWallet({ walletId: '0xuser-one', walletAddress });
const secondVault = deriveVaultForWallet({ walletId: '0xuser-two', walletAddress });
assert.ok(firstVault);
assert.ok(secondVault);
assert.match(firstVault.address, /^ckt1/);
assert.match(secondVault.address, /^ckt1/);
assert.notEqual(firstVault.address, secondVault.address);
assert.equal(firstVault.script.args.length, 2 + 97 * 2);
assert.equal(firstVault.ownerLockHashSource, 'wallet-address');
assert.equal(firstVault.ownerLockHash, ownerLockHashFromAddress(walletAddress));
assert.equal(minimalVaultCellCapacityShannons(firstVault.script), 13_800_000_000);
assert.equal(deriveVaultForWallet({ walletId: '0xuser-one' }), null);

const legacyVault = deriveLegacyVaultForWallet('0xuser-one');
assert.ok(legacyVault);
assert.equal(legacyVault.ownerLockHashSource, 'legacy-wallet-id-derived');
assert.notEqual(legacyVault.address, firstVault.address);

const ownerLockHash = '0x' + '33'.repeat(32);
const userOwnedVault = deriveVaultForWallet({ walletId: '0xuser-one', ownerLockHash });
assert.ok(userOwnedVault);
assert.equal(userOwnedVault.ownerLockHash, ownerLockHash);
assert.equal(userOwnedVault.ownerLockHashSource, 'explicit-lock-hash');

const reclaim = buildVaultOwnerReclaimHandoff({ walletId: '0xuser-one', walletAddress });
assert.ok(reclaim);
assert.equal(reclaim.ownerLockHash, firstVault.ownerLockHash);
assert.equal(reclaim.vaultWitnessLock, '0x00');
assert.equal(reclaim.requiresOwnerAuthInput, true);
assert.equal(isVaultOwnerReclaimAuthorized({
  vault: firstVault,
  ownerAuthInputLock: reclaim.ownerLock,
  vaultWitnessLock: reclaim.vaultWitnessLock
}), true);
assert.equal(isVaultOwnerReclaimAuthorized({
  vault: firstVault,
  ownerAuthInputLock: reclaim.ownerLock,
  vaultWitnessLock: '0x01'
}), false);
