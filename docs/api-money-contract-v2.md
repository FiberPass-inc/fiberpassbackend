# Payment Contract v2 And Legacy Compatibility

Payment contract v2 represents every amount as a canonical base-10 atomic-unit
string and identifies the asset independently from a display currency. The
current contract version is returned by `GET /v2/meta` and the
`X-FiberPass-Contract-Version` response header.

## v2 Shape

New payment-domain contracts use:

```json
{
  "assetId": "ckb:ckb",
  "amountAtomic": "100000000"
}
```

`amountAtomic` has no sign, fraction, exponent, whitespace, or redundant leading
zero. Internal arithmetic uses checked `bigint` with a 256-bit upper bound.
Display decimals are asset metadata and do not participate in accounting.

The `/v2` route prefix is additive while connectors are introduced. Session,
charge, invoice, job, batch, wallet, and funding responses expose exact
`*Atomic` values alongside legacy fields. A client must use the atomic fields
for new integrations.

BTC uses millisatoshis as the shared core unit (11 decimal places). A future
on-chain Bitcoin connector must accept only values divisible by 1000 when it
converts the core amount to satoshis.

## v1 Compatibility

Unversioned and `/v1` routes retain the historical major-unit and numeric
`*Minor` fields for the current CKB/Fiber client. Those fields are a compatibility
projection only and are limited to non-negative JavaScript safe integers. An
amount that cannot be represented exactly by v1 fails with a stable validation
error instead of being rounded.

Existing CKB records are migrated by copying each safe integer minor-unit value
to its exact decimal string without changing the integer. Conflicting, negative,
fractional, or unsafe legacy data stops the migration for operator review.

No v1 numeric field may be used for Bitcoin millisatoshi values above
`9007199254740991`; v2 atomic strings round-trip those values exactly.
