# ADR 0006: Separate Stablecoin And Grant Work Packages

- Status: Accepted
- Date: 2026-07-17

## Context

FiberPass targets the Bitcoin, Lightning, CKB, and Fiber ecosystem. Combining
all rails into one grant claim would obscure security assumptions and make
independent delivery difficult to verify.

## Decision

Grant deliverables are divided into independently testable work packages:

1. Bitcoin and Lightning: existing-wallet authentication, scoped Nostr Wallet
   Connect, self-hosted BTCPay, interactive PSBTs, repeatable payments,
   metered micropayments, receipts, and regtest/signet proof.
2. CKB and Fiber: preservation and connector isolation of the existing Fiber
   execution, plus explicit testnet contract recovery and custody labeling.
3. Stablecoin: allowlisted RGB++/UTXO asset support on CKB/Fiber with canonical
   type-script identity, decimals, conservation checks, issuer metadata, and
   independent security gates.

No EVM, Solana, or TON rail is in scope. Stablecoin support is not implemented
until its connector, allowlist, proofs, and testnet acceptance criteria pass.

## Consequences

Shared core contracts can be funded once, but each ecosystem claim links only
to its own code, tests, deployment evidence, threat model, and milestones.
Marketing and grant documents must distinguish planned work from verified
implementation.
