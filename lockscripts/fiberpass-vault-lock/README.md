# FiberPass Vault Lock

This directory remains the unaudited testnet v1 draft. It does not implement
the constrained per-pass v2 policy and must not receive production or mainnet
funds. The v2 specification and threat model are in
../../docs/ckb-per-pass-vault-v2-spec.md and
../../docs/ckb-per-pass-vault-v2-threat-model.md.

Rust draft for a CKB lock script that holds user vault funds on testnet.

## Purpose

Users load funds into FiberPass vault cells. FiberPass can then wire payment settlement out of those cells while preserving user-level accounting in the backend ledger.

The script is intentionally small:

- It does not keep a global account table on-chain.
- It isolates users through lock args.
- It checks only current script-group inputs and outputs.
- It uses normal CKB lock authorization by requiring a signed owner/operator auth input, so the vault lock does not run expensive signature verification itself.

## Lock Args

```text
byte 0      version, currently 1
bytes 1-32  vault_id_hash
bytes 33-64 owner_lock_hash
bytes 65-96 operator_lock_hash
```

`owner_lock_hash` distinguishes one user's vault cells from another user's vault cells. The backend should derive the testnet vault address from this script and the user's CKB/JoyID-controlled owner lock hash.

`operator_lock_hash` should be a testnet multisig or service-operator lock controlled by FiberPass. Operator authorization is required for payment wiring.

## Cell Data

A plain user deposit may create a vault cell with empty data. Empty-data cells are valid inputs/outputs so a normal wallet transfer to the vault address remains spendable.

Structured vault cells use a compact fixed-width payload:

```text
bytes 0-3    magic: "FPV1"
byte  4      data version, currently 1
bytes 5-36   vault_id_hash
bytes 37-68  record_id_hash
bytes 69-76  nonce, little-endian u64
bytes 77-84  reserved_minor_units, little-endian u64
```

`vault_id_hash` must match the vault id in the lock args, keeping outputs grouped to the same user vault without exposing the raw backend wallet id on-chain.

`record_id_hash` maps the cell to a funding/session ledger record. The cell outpoint is still the canonical record id after confirmation.

`nonce` must increase when structured vault cells are rewritten. This gives the backend a cheap replay/stale-state check when indexing testnet transactions.

## Authorization

The vault lock supports these witness lock actions:

```text
0x00 owner refund/reclaim
0x01 operator payment payout
0x02 operator rebalance/consolidation
```

The script authorizes actions by checking for a signed auth input:

- Owner refund requires any transaction input whose lock hash equals `owner_lock_hash`.
- Operator payout/rebalance requires any transaction input whose lock hash equals `operator_lock_hash`.

Those auth inputs are validated by their own CKB lock scripts. This avoids embedding signature verification inside the vault lock and keeps cycles low.

## Efficient Transaction Shape

For a payment payout:

1. Consume one or more vault cells with the same lock args.
2. Include an operator auth input.
3. Create a change vault output with the same lock args, either empty data or structured data with the same `vault_id_hash`.
4. Wire payment output(s) to the app/Fiber settlement target.
5. Backend records the spent outpoints, resulting change outpoint, and payment proof.

For a user refund:

1. Consume the user's vault cells.
2. Include an owner auth input.
3. Return capacity/assets to the owner's normal lock.

## Build Notes

This is a draft script. A production build should pin the exact CKB toolchain, add molecule transaction-builder tests, and run `ckb-debugger` cycle checks.

Typical testnet build target:

```bash
npm run vault:build
```

Deployment helper:

```bash
CKB_TESTNET_RPC_URL=https://... \
CKB_TESTNET_INDEXER_URL=https://... \
npm run vault:deploy:testnet
```

The deployment helper reads the local deployer wallet from `.local-secrets/fiberpass-lockscript-deployer.testnet.json` by default. The private key file must stay local and must never be committed. Set `BROADCAST=false` for a dry run.
