# Grant Work Packages

FiberPass uses a shared payment-policy core, but grant claims are scoped to
independently verifiable ecosystem outcomes. The implementation backlog and
acceptance criteria are in [`TASKS.md`](../TASKS.md).

## Bitcoin And Lightning

This package covers chain-neutral money contracts, the connector registry,
Nostr Wallet Connect with wallet-enforced limits, self-hosted BTCPay, interactive
Bitcoin PSBTs, fresh Lightning request resolution, repeatable schedules,
metered micropayments, neutral receipts, and reproducible regtest/signet proof.
Nostr Wallet Connect is implemented for externally owned Lightning wallets with
mock-relay regression evidence. BTCPay, PSBT, scheduling, stablecoin, and live
signet evidence remain planned and must not be inferred from that connector.

## CKB And Fiber

This package preserves current Fiber behavior behind a connector, validates
CKB/Fiber destinations and proofs, and documents recovery for the unaudited CKB
testnet contract draft. The contract's operator authorization is a custody risk
and is not described as a user wallet or production-ready vault.

## Stablecoin On CKB/Fiber

This package is limited to allowlisted RGB++/UTXO assets identified by canonical
CKB type scripts. It requires exact atomic-unit accounting, cell conservation,
issuer and risk metadata, connector capability checks, and testnet evidence.
Stablecoin work does not add EVM, Solana, or TON dependencies and is not
production support until those gates pass.

## Evidence Rule

Each application links only to merged code, automated tests, reproducible
network evidence, threat models, and operations documentation for its package.
A demo, roadmap entry, or shared-core abstraction is not evidence that a rail
or asset is implemented.
