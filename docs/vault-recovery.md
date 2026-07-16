# Vault Ownership and Recovery

FiberPass vaults created by the current backend are bound to the authenticated JoyID CKB lock. The vault lock args store `computeScriptHash(parseAddress(wallet.address))`; they are not derived from an internal wallet ID.

## Owner reclaim handoff

An authenticated wallet can request `GET /wallet/vault-recovery`. The response contains:

- the current owner-bound vault script, address, and script hash;
- the authenticated owner's lock script and lock hash;
- vault witness action `0x00`;
- `requiresOwnerAuthInput: true`.

To build an owner reclaim transaction, a wallet client must:

1. Load the live cells locked by `current.vaultScript`.
2. Add at least one input locked by `current.ownerLock`.
3. Add outputs returning the reclaimed capacity to the owner's CKB lock, including enough capacity for fees and change.
4. Set the first vault input witness lock to `0x00`.
5. Sign the owner-auth input with JoyID and submit the completed CKB transaction.

The FiberPass vault lock validates that an input lock hash equals the owner lock hash embedded in the vault args. The normal JoyID lock validates the owner's signature. The backend handoff never contains a private key and must not sign for the owner.

## Legacy synthetic vaults

Older beta builds derived the owner field from `ckbHash("fiberpass:owner:" + walletId)`. No user lock can satisfy that synthetic owner hash, so those cells cannot use owner action `0x00`.

The recovery endpoint identifies the legacy address with `mode: operator-migration-required` and supplies the current owner-bound destination address. Recovery is explicit:

1. Stop presenting the legacy address for new deposits.
2. Enumerate live legacy vault cells and confirm they belong to the authenticated wallet's historical vault ID.
3. Build an operator-authorized vault transaction using the deployed lock's migration/administrative action.
4. Send all recoverable capacity, less the bounded network fee, to `legacy.destinationAddress`.
5. Record the transaction hash and rescan funding at the current vault before declaring migration complete.

Never convert a legacy address into a current address in place, credit both cells, or treat an operator migration as an owner signature. Keep the legacy and current script hashes in the audit record so the transfer can be reconciled exactly once.

## Transaction guarantees

Funding confirmation changes `pending -> confirmed` and credits the wallet in one Mongo transaction. Session creation, top-up reservation, and close refunds also use transactions. Top-up and close operations persist provider submission state; an unknown provider result stays pending and is not retried or refunded blindly.

Run the replica-set coverage with:

```bash
LIFECYCLE_TEST_MONGODB_URI='mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true' npm run test:lifecycle-transactions
```

The test covers concurrent funding confirmation, creation rollback, idempotent top-up, and concurrent revoke/settle refund finalization.
