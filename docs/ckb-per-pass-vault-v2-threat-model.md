# CKB Per-Pass Vault V2 Threat Model

Status: draft paired with ckb-per-pass-vault-v2-spec.md. This document does not
claim an implemented or audited production vault.

## Assets And Trust Boundaries

Protected assets:

- native CKB capacity or one immutable allowlisted UDT type;
- owner reclaim authority;
- committed recipient destination;
- total, per-payment, occurrence, cadence, expiry, and fee limits;
- state nonce, remaining amount, and occurrence count; and
- migration destination and audit continuity.

Trusted for safety:

- CKB consensus and VM;
- the exact deployed v2 lock and state-type code hashes;
- the owner JoyID/CKB lock;
- the operator threshold multisig only for actions the V2 lock permits;
- the selected allowlisted UDT type script; and
- a future approved non-replayable time evidence mechanism, if time policy is
  enabled.

Trusted only for availability or UX:

- FiberPass API, database, indexer, builders, payment workers, and relayers;
- operator signers below threshold;
- recipient endpoint;
- Fiber channel and stablecoin issuer; and
- notification systems.

The backend cannot authorize a transaction the lock rejects. A compromised
backend can censor, delay, submit invalid transactions, or misreport pending
state until users verify the chain.

## Adversary Matrix

| Threat | Attack | Required invariant or mitigation | Residual risk |
| --- | --- | --- | --- |
| Operator compromise | Redirect payout to attacker | recipient_lock_hash is immutable; exact recipient output is checked | Operator can censor payments and expose metadata |
| Operator overspend | Exceed event, total, or occurrence cap | exact u128 arithmetic, per-payment cap, remaining state, occurrence limit | Incorrect policy chosen by owner UI remains possible |
| Operator rapid spend | Ignore cadence or expiry | verified time, next-valid state, expiry check | Time evidence design is unresolved and blocks BE-11 |
| Operator fee theft | Burn vault value as fee | global fee ceiling; exact native group delta; UDT state capacity cannot decrease | Fee ceiling may be economically stale |
| Single key theft | Use service key to pay | operator hash must be reviewed threshold multisig | Threshold signer collusion remains possible within policy |
| Malicious recipient | Substitute address or type | immutable recipient and asset hashes | Recipient can refuse service or become sanctioned/frozen |
| Recipient input recycling | Reuse existing recipient input/output to fake payout | operator payout rejects recipient inputs and checks net transaction shape | Adds transaction size and scan cost |
| Replay | Reuse old state or witness | CKB live-cell single spend, nonce +1, policy hash, provider/backend idempotency | Pre-signed transaction can remain broadcastable until state changes |
| Concurrent payout | Two workers spend one state | one state cell outpoint; only one transaction confirms | Loser must reconcile and rebuild |
| Cell mixing | Spend two pass groups and count one output twice | one V2 code-hash pass group per transaction | Lower throughput; batching stays within one pass |
| Cross-pass theft | Credit pass A from pass B | pass id in lock args/policy/state; group conservation | Indexer bugs can mislabel UI until chain rescan |
| UDT substitution | Use same symbol or malicious type | exact full type script hash and allowlist governance | Issuer freeze/redemption risk is outside lock |
| UDT amount confusion | Overwrite xUDT data with state | separate state cell; first 16 asset bytes remain uint128 amount | Non-standard UDTs require separate review and are rejected |
| Native capacity drain | Shrink state or carrier cells | exact group capacity conservation and fee ceiling | Occupied-capacity changes require careful builders |
| State duplication | Create two successors | unique state type and exactly one state input/output | Initial malformed deposits can be unspendable |
| Policy mutation | Change recipient/cap/operator in output | policy hash in lock args and state; witness policy rehashed | Owner migration intentionally creates a new policy |
| Owner key loss | Owner cannot reclaim | existing JoyID/CKB recovery properties; no FiberPass recovery key | Funds can remain permanently locked |
| Owner compromise | Attacker revokes/reclaims/migrates | owner lock security and wallet signing review | Owner authority is intentionally ultimate |
| Upgrade failure | New lock is buggy | owner-signed full migration, independent creation validation, no in-place mutation | A bad owner-approved target can lock funds |
| Legacy migration | Credit v1 and v2 simultaneously | stop v1 deposits, consume old outpoints, exactly-once migration record | V1 still relies on operator until emptied |
| Time oracle compromise | Reuse pre-expiry timestamp | require anti-replay/freshness proof accepted by maintainers | No accepted design yet |
| Denial of service | Spam invalid payouts or withhold signer | bounded builders/fees, owner unilateral reclaim | Safety preserved, availability lost |
| Supply-chain compromise | Replace script/toolchain/deps | pinned hashes/toolchain, reproducible build, audit artifact checksum | Compiler/runtime zero-days remain |
| Privacy leakage | Link pass, recipient, and payout cadence | hashed random pass id, no email/contact on chain | Public chain still reveals amounts and graph |

## Critical Invariants

The implementation and auditor must prove:

1. Operator payout has exactly one possible recipient.
2. Operator payout cannot increase remaining, occurrence budget, or policy.
3. Every value leaving a native group is either committed recipient value or a
   fee within the ceiling.
4. Every UDT unit leaving the group arrives under the committed recipient lock
   with the exact type hash.
5. No transaction can validate two pass groups against one shared output.
6. Owner reclaim and migration require no operator signature.
7. Owner revoke cannot move or burn vault assets.
8. A revoked state can never return to active.
9. Nonce and occurrence count advance exactly once for their allowed action.
10. Malformed policy, overflow, unknown action/status/asset, duplicate state,
    wrong network genesis, and unexpected type scripts fail closed.

## Time-Evidence Finding

Severity: mainnet blocker.

CKB transaction since enforces not-before. It does not by itself prove that a
transaction is being included before an upper-bound expiry. A spender can
choose an older valid since value. An arbitrary old header dep or reusable
signed timestamp has the same replay issue.

Until maintainers approve a fresh non-replayable construction, choose one:

- disable wall-clock operator expiry/cadence and enforce only caps, occurrence
  count, nonce, and owner revocation;
- integrate an audited stateful time oracle with explicit trust and liveness
  risks; or
- use another protocol-native construction that reviewers confirm proves the
  required upper and lower bounds.

The current reference model deliberately requires abstract verified time so
tests cannot accidentally bless a replayable implementation.

## Operational Controls

- Use geographically and administratively separated threshold operator keys.
- Keep owner and operator lock hashes visible before funding.
- Require wallet review of recipient, asset type hash, caps, fee ceiling,
  cadence, occurrence limit, expiry mode, and recovery action.
- Disable v1 deposit addresses before any migration.
- Monitor state outpoints and reconcile unknown submissions before rebuilding.
- Publish deployed code hashes, Molecule schema hash, compiler versions, cycle
  budget, audit report, and reproducible artifact checksum.
- Pause new funding on any invariant mismatch; never patch database balances to
  hide a chain discrepancy.

## Accepted Residual Risks

For testnet specification review only:

- public CKB transaction metadata is observable;
- operator or recipient can deny service;
- owner key compromise or loss follows the owner wallet's security model;
- allowlisted UDT issuer, freeze, and redemption risk remains external;
- a policy the owner explicitly approves can be economically unfavorable;
- legacy v1 funds retain operator risk until migrated; and
- current v2 time policy is unresolved and no production implementation may
  ship.

Not accepted:

- unrestricted operator withdrawal;
- single operator key in production;
- symbol-based UDT identity;
- backend-only cap enforcement;
- operator-only migration;
- silent mainnet deployment;
- replayable expiry evidence; or
- unresolved critical/high audit findings.
