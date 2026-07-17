# ADR 0002: Distinguish Authorization From Locked Funds

- Status: Accepted
- Date: 2026-07-17

## Context

A connected wallet balance, spending authorization, payment-channel balance,
database reservation, and on-chain contract output provide different
guarantees. Calling all of them a vault or wallet balance hides custody risk.

## Decision

FiberPass exposes two target funding modes:

- `connected_wallet`: a scoped authorization against external wallet liquidity.
  Funds are not locked by FiberPass and execution can fail if liquidity changes.
- `secured_autopay`: funds or an allowance are verifiably locked or enforced by
  a network or external wallet. The connector records the proof and recovery
  path.

Ledger states explicitly distinguish `authorized`, `locked`, `reserved`,
`spent`, `released`, and `reclaimable`. A MongoDB reservation is never described
as an on-chain lock. The current CKB owner-bound contract includes an operator
spend path, is an unaudited testnet draft, and carries custody risk; it is not a
per-user wallet.

## Consequences

Balance responses require rail, asset, source, freshness, and guarantee fields.
Mainnet activation requires a separate audit and custody decision. Legacy CKB
records retain an explicit operator-contract risk label during migration.
