# Funding Sources and Guarantees

FiberPass separates a payment authorization from proof-backed funds. A pass
always points to one funding source and one allocation; it never treats the
legacy wallet balance projection as proof that a payment can execute.

## Funding modes

### `connected_wallet`

The user authenticates with an existing JoyID CKB wallet. FiberPass records a
scoped authorization for the pass, but it does not lock funds and does not
issue or control the wallet address. An observed wallet balance can improve the
guarantee from `authorization_only` to `balance_observed`; that observation can
become stale or fall below outstanding authorizations without deleting the
pass. Execution remains connector-dependent and may fail when current
liquidity or wallet authorization is unavailable.

### `secured_autopay`

The source represents funds or an allowance enforced by a network contract or
connector. A new allocation requires a fresh network proof and sufficient
unallocated locked value. The current CKB owner-bound contract is an unaudited
operator-controlled testnet design, so it is exposed as
`network_locked_operator_controlled` with the
`unaudited_operator_contract` risk label. This is not a wallet issued by
FiberPass and is not production custody.

## Accounting contract

All public amounts are exact atomic-unit strings. The numeric minor-unit fields
in MongoDB exist only as the current CKB/Fiber compatibility representation.

| Field | Meaning |
| --- | --- |
| `available` | Latest observed external balance or network-locked amount. |
| `authorized` | Unspent and unreleased value granted across active passes. |
| `locked` | Value proven to be enforced by the secured source. Always zero for a connected wallet. |
| `policyReserved` | Secured value allocated to active pass policy. This is not a MongoDB lock. |
| `spent` | Value finalized through payment execution. |
| `released` | Unused authorization returned by closing or exhausting a pass. |
| `reclaimable` | Secured locked value not allocated to passes, or observed connected balance above authorizations. |

The session field `mongoExecutionReservationAtomic` is a short-lived database
reservation for one charge attempt. It must never be described as on-chain
locked value.

The invariants are:

```text
allocation.remaining = allocation.authorized - allocation.spent - allocation.released
secured.reclaimable = secured.locked - secured.policyReserved
source.authorized = sum(active allocation remaining)
```

Creating concurrent secured passes is transactionally bounded by
`locked - policyReserved`. Spending and releasing update the source and
allocation in the same MongoDB transaction. Release is idempotent.

## Source states and failures

Sources use `unverified`, `available`, `fully_allocated`, `insufficient`,
`stale`, `failed`, or `revoked`.

- A connected source is `unverified` until a balance is observed,
  `insufficient` when the observed balance is zero or below aggregate active
  authorizations, and `stale` after its observation deadline.
- A secured source is `unverified` without a network proof,
  `fully_allocated` when locked value equals policy reservations,
  `insufficient` when a live network observation is below reservations, and
  `stale` after its proof deadline.
- New secured allocations and top-ups reject missing or stale proofs.
- Execution rechecks allocation capacity, proof freshness, source counters,
  and connector capability. A persisted pass is not evidence that the next
  payment is executable.

Connector discovery exposes each supported mode, guarantee, balance source,
proof requirement, execution support, and explicit failure states. The current
Fiber connector does not claim that connected-wallet authorization alone can
execute unattended payments.

## API contract

Authenticated source details are returned by:

- `GET /wallet/funding-sources`
- `GET /auth/me` in `wallet.fundingSources`
- `GET /sessions` in `wallet.fundingSources` and each pass `funding` object
- `GET /sessions/create-policy` in the supported modes and selectable sources
- `GET /payment-connectors` in connector funding capabilities

Every source response identifies `mode`, `sourceKind`, `sourceReference`,
`rail`, `network`, `assetId`, `guarantee`, `riskLabel`, balances, proof,
freshness, and any current failure. Clients must render these labels instead of
presenting the legacy `wallet.balance` projection as guaranteed funds.

Creating a pass accepts optional `fundingMode` and `fundingSourceId`. If neither
is supplied, FiberPass selects a fresh, sufficiently funded secured source and
otherwise creates a connected-wallet authorization. It never auto-selects a
stale secured source.

## Legacy migration

Migration `006-model-funding-sources` converts historic wallet, funding, and
pass records into one `legacy_operator_vault` source per wallet plus one
allocation per pass. Only confirmed deposits with a recorded chain out point
or proof contribute to locked value. Historic proofs are treated as stale
after five minutes and must be refreshed from live cells before execution.

Legacy records retain `network_locked_operator_controlled` and
`legacy_operator_vault` labels. Missing proof, stale proof, or aggregate
shortfall blocks execution rather than upgrading an accounting balance into a
network guarantee.
