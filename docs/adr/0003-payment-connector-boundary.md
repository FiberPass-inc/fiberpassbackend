# ADR 0003: Isolate Payment Rails Behind Connectors

- Status: Accepted
- Date: 2026-07-17

## Context

Core scheduling and accounting cannot remain correct if Fiber invoice fields,
Bitcoin addresses, or Lightning wallet secrets leak into shared policy code.

## Decision

Core code works with neutral assets, atomic amounts, intents, results,
destinations, and proofs. A connector owns capability discovery, destination
validation, quotes, execution, lookup, reconciliation, and optional refund for
one rail/network/asset capability. A registry selects connectors by explicit
capability, not currency conditionals.

Protocol secrets and raw RPC responses stay inside the connector. Connectors map
errors and proofs into stable public contracts. Unsupported combinations fail
before funds are reserved.

## Consequences

The existing CKB/Fiber implementation must first be wrapped without regression.
Bitcoin, Lightning, and stablecoin connectors use the same contract suite, while
their protocol-specific validation and operational dependencies remain
independent.
