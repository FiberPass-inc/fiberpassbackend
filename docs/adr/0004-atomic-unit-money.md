# ADR 0004: Represent Money In Atomic Units

- Status: Accepted
- Date: 2026-07-17

## Context

JavaScript numbers cannot exactly represent all millisatoshi, satoshi, shannon,
or token values and floating-point arithmetic is unsuitable for money.

## Decision

Every API and persistence boundary represents an amount as a canonical base-10
non-negative integer string plus an explicit asset identifier. Internal
arithmetic uses checked `bigint`. Parsing rejects fractions, signs, exponents,
leading ambiguity, unsafe legacy numbers, and values outside the asset or policy
limit.

Display formatting is derived from asset metadata and never feeds accounting.
Historical numeric CKB fields migrate by exact integer conversion with a
versioned compatibility contract.

## Consequences

Policies, ledgers, schedules, receipts, and connectors share one tested money
module. Addition, subtraction, comparison, caps, serialization, and formatting
need boundary and property tests.
