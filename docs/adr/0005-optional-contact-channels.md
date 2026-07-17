# ADR 0005: Keep Contact Channels Optional

- Status: Accepted
- Date: 2026-07-17

## Context

Email is useful for destination claims and receipts, but requiring it would tie
payment identity to personal contact data and incorrectly imply wallet proof.

## Decision

A payer can create and execute a pass without email. Wallet principals,
recipient payment destinations, claim channels, and notification endpoints are
separate records. Email and Nostr are optional delivery mechanisms for a claim
or receipt. Verification of either channel does not verify a wallet.

Claim tokens are random, hashed at rest, single-use, expiring, and revocable.
Recurring schedules resolve a fresh request through a reusable verified
destination endpoint rather than retaining a stale invoice.

## Consequences

Contact data has separate consent, export, retention, and deletion behavior.
Immutable payment proofs remain available after optional contact data is
deleted, subject to the documented retention policy.
