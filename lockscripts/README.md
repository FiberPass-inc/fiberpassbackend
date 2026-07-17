# FiberPass Lock Scripts

This folder contains CKB lock-script drafts owned by the backend repo.

The first script is `fiberpass-vault-lock`, an unaudited testnet contract draft
for holding user-funded cells that back FiberPass payment sessions. Its
owner-bound address is not a wallet and FiberPass does not generate a seed for
it.

## Vault Model

FiberPass should deploy one vault lock binary, then derive per-user vault addresses by changing script args:

```text
args = version | vault_id_hash | owner_lock_hash | operator_lock_hash
```

This keeps accounting efficient:

- One script binary is shared by all users.
- Each user gets distinct vault cells because `owner_lock_hash` is part of the lock args.
- Spend transactions only validate the current script group, not a global pooled balance.
- Backend funding records map user wallet ids to vault outpoints and funding request ids.

The current backend `WalletFunding` ledger should move from a static treasury address to per-user vault-address derivation after the script is deployed and the testnet code hash is known.

## Status

Draft for testnet integration. Not audited. Do not use on mainnet without formal review, transaction-builder tests, and CKB debugger cycle checks.
