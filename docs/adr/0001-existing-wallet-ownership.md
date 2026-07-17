# ADR 0001: Authenticate With Existing Wallets

- Status: Accepted
- Date: 2026-07-17

## Context

FiberPass needs payer authorization and recipient destinations across Bitcoin,
Lightning, CKB, and Fiber without becoming a general wallet provider.

## Decision

Users authenticate by proving control through a supported existing wallet.
FiberPass never generates or issues a user wallet, seed phrase, or unrestricted
signing key and never stores one. A wallet proof establishes a principal; it is
not a payment destination, contact address, guarantee of current liquidity, or
permission to spend beyond the signed/scoped authorization.

Recipient destinations are separate records with rail-specific verification.
Email and Nostr identifiers are notification or claim channels only and never
prove wallet ownership.

## Consequences

Every connector must use least-privilege authorization and support revocation.
Interactive on-chain Bitcoin uses wallet-reviewed PSBTs. Unattended Lightning
requires a wallet-enforced scoped allowance. CKB ownership and operator actions
remain distinguishable in API, ledger, and receipt data.
