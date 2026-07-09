#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { utils } from '@ckb-lumos/lumos';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const crateDir = resolve(scriptDir, '..');
const binaryPath = resolve(crateDir, 'target/riscv64imac-unknown-none-elf/release/fiberpass-vault-lock');

const build = spawnSync('cargo', ['build', '--release', '--target', 'riscv64imac-unknown-none-elf'], {
  cwd: crateDir,
  stdio: 'inherit'
});

if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (!existsSync(binaryPath)) {
  throw new Error('Release binary was not found at ' + binaryPath);
}

const binary = readFileSync(binaryPath);
const dataHash = utils.ckbHash(binary);

console.log('binary=' + binaryPath);
console.log('bytes=' + binary.length);
console.log('data_hash=' + dataHash);
console.log('hash_type=data2');
console.log('');
console.log('If deploying as data/data2 code, use:');
console.log('FIBERPASS_VAULT_CODE_HASH=' + dataHash);
console.log('FIBERPASS_VAULT_HASH_TYPE=data2');
