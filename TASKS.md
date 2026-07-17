# FiberPass Backend Tasks

This file contains the new backend execution backlog. The previous organization
issues are complete and are intentionally not repeated here. Each heading below
is one issue-sized task and must be executed in numeric order unless its
dependencies are already complete.

The workspace-level phase sequence is maintained alongside both local
repositories. This repository file is the authoritative backend issue source;
its task ids are referenced by the frontend tracker.

## Status

- All tasks start as `ready` when their dependencies are complete.
- No task in this file is complete at creation time.
- Update the GitHub issue, not this file, with transient progress.
- Change this roadmap only when scope, dependency, or acceptance criteria
  materially change.

## Backend-Wide Rules

- Store monetary amounts as atomic-unit integer strings or `bigint` internally.
- Never use floating-point arithmetic for BTC, millisatoshis, CKB, or assets.
- Never store a wallet seed phrase or unrestricted wallet credential.
- Never log bearer tokens, NWC connection secrets, invoices, preimages, email
  claim tokens, or stablecoin proof material.
- Keep Bitcoin/Lightning, CKB/Fiber, and asset-specific validation inside
  connectors.
- Every externally triggered mutation needs authorization, idempotency, audit,
  retry, and recovery behavior.
- Existing Fiber functionality must remain covered while it is moved behind the
  connector boundary.
- Mainnet activation is a separate decision after test-network proof and
  security review.

## Suggested Ownership

| Implementer | Tasks | Reviewer |
| --- | --- | --- |
| `buidlLabs3` | BE-01, BE-03, BE-05, BE-07, BE-10, BE-12, BE-14, BE-16 | `FidelCoder` |
| `FidelCoder` | BE-02, BE-04, BE-06, BE-08, BE-09, BE-11, BE-13, BE-15 | `buidlLabs3` |

## BE-01: Establish The Public FOSS And Architecture Baseline

**Depends on:** None

**Outcome:** Both the implementation and its grant-facing public contract have
unambiguous licensing, contribution, security, custody, and terminology rules.

**Scope:**

- Add the intended repository license and ensure package metadata matches it.
- Add contribution and vulnerability-reporting instructions.
- Add architecture decision records for wallet ownership, funding modes,
  connector isolation, atomic-unit money, optional email, and stablecoin scope.
- Replace language that calls a contract vault a wallet.
- Mark the existing CKB vault as testnet draft wherever it appears.

**Acceptance criteria:**

- [ ] A root license file exists and is referenced by the README.
- [ ] `CONTRIBUTING.md` and `SECURITY.md` define public workflows.
- [ ] ADRs state that FiberPass never issues wallets or stores user seeds.
- [ ] ADRs distinguish connected-wallet authorization from locked funds.
- [ ] Documentation identifies Bitcoin/Lightning grant deliverables separately
      from CKB and stablecoin work packages.
- [ ] Documentation links resolve and contain no demo-only claims.

**Validation:** Markdown link check, package metadata check, secret scan, and
documentation review by the non-implementing account.

## BE-02: Introduce Chain-Neutral Money And Payment Contracts

**Depends on:** BE-01

**Outcome:** Core policy, ledger, scheduling, and receipt code no longer assumes
CKB or Fiber invoice shapes.

**Scope:**

- Define `AssetId`, `AtomicAmount`, `PaymentRail`, `PaymentIntent`,
  `PaymentQuote`, `PaymentResult`, and `PaymentStatus`.
- Represent amounts as base-10 atomic-unit strings at API and persistence
  boundaries and as checked integers internally.
- Add rail-neutral destination and proof types.
- Version public response contracts and migrate legacy CKB numeric fields
  without changing historical value.

**Acceptance criteria:**

- [ ] Core money helpers reject fractional, negative, unsafe, or overflow input.
- [ ] BTC millisatoshis above JavaScript's safe integer range round-trip exactly.
- [ ] Existing CKB values migrate to exact atomic amounts.
- [ ] Core session and charge policy types contain no Fiber invoice enum.
- [ ] Legacy API clients receive a documented compatibility response or error.
- [ ] Property tests cover parsing, addition, subtraction, caps, and formatting.

**Validation:** Unit/property tests, migration test against a production-shaped
fixture, TypeScript compilation, and API contract tests.

## BE-03: Add The Connector Registry And Wrap Existing Fiber Execution

**Depends on:** BE-02

**Outcome:** Payment execution is selected through capabilities instead of
currency conditionals, while all current CKB/Fiber behavior remains functional.

**Scope:**

- Define a small `PaymentConnector` interface for capabilities, destination
  validation, quote, execute, lookup, and optional refund.
- Add a registry keyed by rail, network, and asset capability.
- Move Fiber invoice parsing, CKB address rules, node readiness, and Fiber
  execution behind `FiberConnector`.
- Translate connector results into the neutral payment result and receipt model.

**Acceptance criteria:**

- [ ] Core services do not branch on `currency === 'CKB'` to execute payment.
- [ ] Unsupported rail/asset pairs fail before reservation.
- [ ] Connector capability discovery is exposed through an authenticated API.
- [ ] Existing Fiber invoice amount, network, signature, expiry, and payment
      proof checks still pass.
- [ ] Connector failures map to stable public codes without leaking raw RPC data.
- [ ] A fake connector can run deterministic unit and integration tests.

**Validation:** Existing Fiber suite, new connector contract suite, route tests,
and a real Fiber testnet smoke test when configured.

## BE-04: Separate Wallet Identity, Recipient Destination, And Contact Data

**Depends on:** BE-02

**Outcome:** A wallet proves payer control, a destination receives payment, and
email/Nostr only deliver claims or notifications.

**Scope:**

- Introduce `WalletPrincipal`, `Recipient`, `PaymentDestination`,
  `ClaimChannel`, and `NotificationEndpoint`.
- Migrate existing recipient email/address/invoice fields.
- Make every contact channel optional.
- Hash claim tokens at rest and enforce single use, expiry, revocation, and
  destination replacement rules.
- Record destination verification independently from contact verification.

**Acceptance criteria:**

- [ ] A pass can be created and paid without any email address.
- [ ] An email-only recipient can claim and bind a supported destination.
- [ ] Email verification never proves wallet ownership.
- [ ] Repeated schedules bind to a reusable endpoint, not a stale invoice.
- [ ] Expired, reused, or revoked claim links cannot alter a destination.
- [ ] Data export and deletion cover contact information without deleting
      immutable payment proofs.

**Validation:** Migration, authorization, claim-race, privacy, and API contract
tests.

## BE-05: Model Connected-Wallet And Secured Auto-Pay Funding

**Depends on:** BE-02, BE-04

**Outcome:** The ledger and API truthfully distinguish wallet balance, policy
authorization, channel liquidity, contract-locked funds, and spent funds.

**Scope:**

- Add `connected_wallet` and `secured_autopay` funding modes.
- Track authorized, locked, reserved, spent, released, and reclaimable amounts.
- Prevent Mongo reservations from being reported as on-chain locks.
- Define connector-specific funding guarantees and failure states.
- Prevent aggregate pass authorizations from silently presenting as guaranteed
  wallet liquidity.

**Acceptance criteria:**

- [ ] API balances state their source, freshness, rail, asset, and guarantee.
- [ ] Connected-wallet passes continue to exist if balance changes, but report
      insufficient liquidity honestly at execution.
- [ ] Secured auto-pay cannot be marked funded without network proof.
- [ ] Release and reclaim transitions are idempotent and exactly accounted.
- [ ] Concurrent pass creation cannot over-reserve a locked funding source.
- [ ] Legacy vault balances migrate with an explicit `legacy_operator_vault`
      risk label.

**Validation:** Transactional concurrency suites, migration fixtures, connector
balance tests, and invariants over the funding state machine.

## BE-06: Implement Scoped Nostr Wallet Connect Lightning Execution

**Depends on:** BE-03, BE-05

**Outcome:** A user can connect an existing Lightning wallet and execute BTC
payments without FiberPass operating or holding the wallet seed.

**Scope:**

- Pair using NIP-47 connection URIs and negotiate advertised capabilities.
- Prefer NIP-44 encryption and unique connection keys.
- Encrypt connection material at rest and support explicit disconnect/revoke.
- Support balance, invoice payment, invoice lookup, and transaction status only
  when advertised by the wallet.
- Separate interactive connections from unattended, wallet-limited connections.

**Acceptance criteria:**

- [ ] Connection secrets never enter URLs, logs, analytics, or API responses
      after initial pairing.
- [ ] An NWC connection without a hard wallet allowance cannot enable cloud
      unattended auto-pay.
- [ ] One pass or application can be disconnected without affecting others.
- [ ] Invoice amount, network, expiry, duplicate payment, and result proof are
      verified before a debit is final.
- [ ] Timeout and unknown-result states reconcile before retry.
- [ ] A local mocked relay and at least one compatible test wallet pass E2E.

**Validation:** Protocol fixtures, encrypted-message tests, timeout/replay tests,
secret scan, and Lightning regtest/signet E2E.

## BE-07: Add Self-Hosted BTCPay And Bitcoin PSBT Paths

**Depends on:** BE-03, BE-05

**Outcome:** FiberPass supports self-hosted Bitcoin/Lightning operations and
interactive on-chain Bitcoin without signing for the user.

**Scope:**

- Add a least-privilege BTCPay Greenfield connector.
- Add Bitcoin address, BIP21, network, amount, and confirmation validation.
- Build PSBT requests for interactive on-chain payments and return them to the
  user's wallet for signing.
- Track broadcast, confirmation, replacement, abandonment, and fee states.

**Acceptance criteria:**

- [ ] BTCPay API keys are scoped, encrypted, revocable, and never returned.
- [ ] FiberPass never signs a Bitcoin input or stores a Bitcoin seed.
- [ ] PSBT outputs exactly match the reviewed recipient, amount, and fee policy.
- [ ] Wrong-network and address-substitution attempts are rejected.
- [ ] A signed PSBT is revalidated before broadcast.
- [ ] Regtest covers receive, Lightning pay, on-chain pay, confirmation, and
      restart recovery.

**Validation:** Bitcoin Core regtest, BTCPay integration fixture, PSBT mutation
tests, and restart/reconciliation tests.

## BE-08: Resolve Fresh Requests For Scheduled Repeatable Payments

**Depends on:** BE-04, BE-06, BE-07

**Outcome:** One-time and recurring schedules remain supported without invoice
reuse or duplicate execution.

**Scope:**

- Add reusable destination resolvers for BOLT12 offers, LNURL/Lightning Address,
  recipient-hosted endpoints, and supported Fiber endpoints.
- Resolve a fresh amount-bound request for every occurrence.
- Persist a stable occurrence id and payment request hash.
- Separate schedule calculation from payment execution and retries.

**Acceptance criteria:**

- [ ] BOLT11 and amount-specific asset requests are never reused.
- [ ] Resolved asset, amount, recipient, network, and expiry match the pass.
- [ ] One occurrence executes at most once across concurrent workers.
- [ ] Unknown payment results reconcile before retry.
- [ ] Pause, revoke, depletion, occurrence limit, and expiry block future runs.
- [ ] Daily, weekly, monthly, and custom schedules handle timezone and calendar
      boundaries deterministically.

**Validation:** Fake-clock schedule tests, concurrent worker suite, resolver
contract tests, and multi-occurrence Lightning E2E.

## BE-09: Preserve Metered Micropayments With Safe Batching

**Depends on:** BE-03, BE-05, BE-06

**Outcome:** Applications and agents can submit repeatable usage charges while
the pass enforces every event and chooses immediate or batched settlement.

**Scope:**

- Define immutable usage events with app id, recipient, asset, atomic amount,
  external id, and policy reference.
- Enforce owner-bound application grants and per-charge, total, rate, expiry,
  and recipient constraints.
- Add rail-aware economic thresholds and bounded settlement batches.
- Preserve an individual receipt for every usage event.

**Acceptance criteria:**

- [ ] Duplicate external ids cannot debit twice under concurrency.
- [ ] A batch cannot mix owners, passes, recipients, assets, or rails.
- [ ] Batch failure releases or retries each reservation deterministically.
- [ ] Immediate and batched totals equal the exact sum of accepted events.
- [ ] Revocation blocks new events and safely finalizes or releases open batches.
- [ ] High-volume tests prove no overspend or floating-point drift.

**Validation:** Property tests, contention integration suite, worker restart
suite, and Lightning/Fiber microcharge E2E.

## BE-10: Specify And Threat-Model The CKB Per-Pass Vault V2

**Depends on:** BE-01, BE-02, BE-05

**Outcome:** An implementation-ready CKB lock specification removes unrestricted
operator payout authority and limits the blast radius to one pass.

**Scope:**

- Define lock args and cell data for owner, policy, asset, recipient commitment,
  operator multisig, total cap, per-payment cap, cadence, occurrence count,
  expiry, fee ceiling, remaining amount, and nonce.
- Specify owner reclaim, operator payout, change, revoke, expiry, and migration.
- Threat-model operator compromise, malicious recipients, replay, cell mixing,
  fee theft, race conditions, UDT substitution, and upgrade failure.
- Obtain review from CKB/Fiber maintainers before implementation.

**Acceptance criteria:**

- [ ] The operator cannot redirect funds or exceed any committed cap.
- [ ] One pass cannot consume another pass's cells.
- [ ] Owner recovery requires the existing JoyID/CKB wallet, not FiberPass.
- [ ] The specification covers native CKB and allowlisted UDT conservation.
- [ ] All state transitions have valid and invalid transaction examples.
- [ ] Open questions and accepted residual risks are explicit.

**Validation:** Written threat-model review, transaction model tests, maintainer
feedback record, and reviewer sign-off. No mainnet code ships in this task.

## BE-11: Implement, Migrate, And Audit The CKB Per-Pass Vault V2

**Depends on:** BE-10

**Outcome:** Secured CKB auto-pay uses audited per-pass cells with unilateral
owner recovery and on-chain policy enforcement.

**Scope:**

- Implement the approved lock and transaction builders.
- Add funding, constrained payout, change, revoke, expiry, and reclaim flows.
- Stop new deposits to legacy per-user/operator vault addresses.
- Build an explicit, exactly-once migration or owner withdrawal path.
- Add operator threshold signing and production key-rotation procedures.

**Acceptance criteria:**

- [ ] Script rejects wrong recipient, asset, amount, cadence, fee, nonce, or
      pass id.
- [ ] Owner can reclaim remaining funds without an operator signature.
- [ ] Operator cannot produce a valid unrestricted withdrawal.
- [ ] Legacy migration cannot double-credit or combine owners.
- [ ] Molecule builders, `ckb-debugger`, cycle limits, and testnet E2E pass.
- [ ] Independent security review has no unresolved critical or high finding.

**Validation:** Script unit/property tests, adversarial transaction vectors,
testnet deployment, recovery drill, external review, and reproducible hash.

## BE-12: Add The Asset Registry And Fiber Multi-Asset Execution

**Depends on:** BE-03, BE-05, BE-11

**Outcome:** Stablecoins and RGB++/UDT assets are accepted only by immutable,
reviewed identity and can use Fiber without weakening native CKB behavior.

**Scope:**

- Add versioned asset definitions containing rail, network, issuer, immutable
  asset/type-script identity, decimals, proof source, limits, and risk flags.
- Remove the blanket UDT rejection only for allowlisted assets.
- Extend Fiber invoice parsing and payment validation to exact asset identity.
- Add governance for enable, pause, deprecate, and emergency disable.

**Acceptance criteria:**

- [ ] Symbol or display name alone can never select an asset.
- [ ] Unknown, mismatched, paused, or wrong-network assets fail before reserve.
- [ ] Decimal conversion is exact and asset-specific.
- [ ] Native CKB and UDT balances cannot be mixed.
- [ ] Issuer, freeze, redemption, liquidity, and experimental metadata are
      exposed through the API.
- [ ] Testnet multi-asset payments and vault conservation tests pass.

**Validation:** Registry signature/version tests, invoice mutation tests, Fiber
testnet asset E2E, and emergency-disable drill.

## BE-13: Add An Experimental Taproot Assets Stablecoin Connector

**Depends on:** BE-02, BE-03, BE-07, BE-12

**Outcome:** FiberPass can test stablecoin payments anchored to Bitcoin and
routed through Lightning without claiming unsupported production readiness.

**Scope:**

- Integrate `tapd` and `litd` through authenticated local APIs.
- Validate asset id/group key, amount, universe proof, network, invoice, edge
  liquidity quote, and payment result.
- Keep asset keys and proof database under the user's node ownership.
- Implement backup, restore, proof recovery, and feature-flag requirements.

**Acceptance criteria:**

- [ ] No asset is labeled USDt without verified issuer identifiers and support.
- [ ] The connector is disabled by default and marked experimental.
- [ ] FiberPass cannot spend asset or Bitcoin keys by itself.
- [ ] Missing `tapd` state cannot be represented as a healthy recoverable wallet.
- [ ] Quote expiry and insufficient edge liquidity fail without a debit.
- [ ] Signet covers send, receive, restart, backup, restore, and proof recovery.

**Validation:** Taproot Assets signet suite, destructive recovery drill on test
data, quote mutation tests, and documented operational review.

## BE-14: Add Explicit Lightning-Fiber Route Quotes And Recovery

**Depends on:** BE-03, BE-12, BE-13

**Outcome:** Cross-network payment or swap paths are visible, bounded, and
recoverable instead of being hidden inside ordinary execution.

**Scope:**

- Define route quotes with input/output asset, amounts, fees, rate source,
  provider, liquidity, expiry, trust model, and refund path.
- Integrate Fiber cross-network capabilities only when supported by the running
  node and selected assets.
- Require explicit pass authorization for conversion.
- Persist each route phase and reconcile unknown states.

**Acceptance criteria:**

- [ ] A quote cannot execute after expiry or with changed output terms.
- [ ] Users can distinguish direct payment from conversion.
- [ ] Slippage, service fee, network fee, and expected received amount are exact.
- [ ] Partial or failed routes expose a deterministic retry/refund action.
- [ ] Cross-network execution cannot bypass pass asset or recipient constraints.
- [ ] Testnet fault injection covers every route phase.

**Validation:** Quote signing/immutability tests, state-machine property tests,
Lightning/Fiber testnet E2E, and refund drills.

## BE-15: Separate Receipts From Email And Add Private Notifications

**Depends on:** BE-04, BE-08, BE-09

**Outcome:** Every payment has an in-app cryptographic/network receipt while
email and Nostr remain optional delivery mechanisms.

**Scope:**

- Define immutable receipt records for occurrence, usage events, settlement,
  payment hash/txid, asset, amount, fees, and status.
- Add optional email and Nostr notification endpoints.
- Minimize notification payloads and never include wallet credentials,
  preimages, or private invoice material.
- Add delivery retry, unsubscribe, endpoint revocation, and retention rules.

**Acceptance criteria:**

- [ ] Payments work with no notification endpoint.
- [ ] One receipt can be delivered through multiple optional channels.
- [ ] Notification failure never changes payment success.
- [ ] Email claim and email receipt tokens are distinct and single-purpose.
- [ ] Nostr payloads use current encrypted messaging guidance.
- [ ] Users can export receipts and remove contact endpoints.

**Validation:** Privacy tests, delivery retry suite, template snapshot tests,
secret scan, and data-retention tests.

## BE-16: Ship The Self-Hosted Executor And Public Proof Matrix

**Depends on:** BE-06 to BE-15

**Outcome:** Reviewers and users can reproduce the Bitcoin-first system, run it
without FiberPass custody, and verify every supported funding/payment mode.

**Scope:**

- Package `fiberpassd` for local/self-hosted policy execution.
- Add least-privilege configuration for NWC, BTCPay, Bitcoin Core, Fiber, and
  optional asset connectors.
- Publish Docker and native setup, backups, upgrades, incident response, and
  key rotation.
- Build a deterministic E2E matrix and public demonstration scripts.
- Publish threat model, benchmarks, accessibility inputs, and grant milestone
  reports.

**Acceptance criteria:**

- [ ] A clean machine can run Bitcoin/Lightning regtest without cloud secrets.
- [ ] Self-hosted execution remains functional when FiberPass Cloud is offline.
- [ ] CKB/Fiber and stablecoin connectors are independently enableable.
- [ ] Reproducible builds and artifact checksums are published.
- [ ] E2E covers connected wallet, scheduled repeat, microcharge batch, secured
      CKB pass, owner reclaim, receipt, and failure recovery.
- [ ] Security checklist and grant evidence contain only verified behavior.

**Validation:** Clean-room deployment, full CI/E2E matrix, backup/restore and
upgrade drills, dependency and secret scans, and cross-account final review.
