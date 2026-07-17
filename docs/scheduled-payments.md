# Fresh-Request Scheduled Payments

FiberPass schedules one-time and recurring payments without storing a wallet
seed or reusing an amount-bound invoice. A pass is the authorization and
lifecycle boundary. A reusable recipient destination produces a fresh request
for each occurrence, and an existing wallet or self-hosted service executes it.

## Execution Contract

Each due occurrence follows this order:

1. Derive a stable occurrence id from the schedule id and due time.
2. Claim the occurrence with a bounded worker lease.
3. Confirm that the pass, recipient destination, asset, rail, network, expiry,
   occurrence count, and exact remaining authorization are still valid.
4. Reserve the exact atomic amount for connected Lightning execution.
5. Resolve a fresh amount-bound request and persist only its SHA-256 hash.
6. Execute with the occurrence id as the provider idempotency key.
7. Persist a proof and move the reservation to spent, or retain it while an
   unknown provider result is reconciled.
8. Calculate the next calendar occurrence only after success.

The unique occurrence id, unique payment-request hash, execution lease, and
provider idempotency key prevent two workers from paying the same occurrence.
An executor record is looked up before a crashed worker resolves or submits
anything again.

Raw BOLT11/Fiber requests and Lightning preimages are not stored in schedule or
occurrence records. Occurrences retain request hashes, payment hashes, executor
record ids, and non-secret proof references.

## Reusable Destinations

Supported destination kinds are:

- `lightning_address`: resolves LUD-16 to an LNURL-pay endpoint, then requests a
  fresh BOLT11 for the exact millisatoshi amount.
- `lnurl`: decodes the LNURL-pay URL and requests a fresh exact BOLT11.
- `bolt12_offer`: stores the offer and calls a configured offer-capable resolver
  endpoint. Current NWC and BTCPay executors pay BOLT11, so the adapter must
  obtain a fresh invoice from the offer recipient. FiberPass does not pretend a
  BOLT11-only wallet can pay an offer natively.
- `endpoint`: calls a recipient-hosted or supported Fiber endpoint using the
  structured contract below.

One-time invoices and raw addresses are not reusable schedule destinations.
Replacing a destination updates compatible active schedules. An incompatible
replacement pauses affected schedules for explicit owner review.

Public endpoints must use HTTPS on port 443. DNS answers are checked against
private, loopback, link-local, documentation, and metadata ranges and pinned for
the outbound request. Redirects, embedded credentials, oversized responses,
and fragments are rejected. Local HTTP is available only when
`SCHEDULE_ALLOW_INSECURE_LOCAL_RESOLVERS=true`, which production configuration
rejects.

### Endpoint Request

```json
{
  "contractVersion": "2.0",
  "occurrenceId": "occ_<sha256>",
  "dueAt": "2026-07-18T06:00:00.000Z",
  "recipientId": "rcp_...",
  "destinationId": "dst_...",
  "rail": "lightning",
  "network": "regtest",
  "assetId": "bitcoin:btc",
  "amountAtomic": "2500000"
}
```

A BOLT12 adapter also receives `offer`. The endpoint response is strict:

```json
{
  "paymentRequest": "lnbcrt...",
  "rail": "lightning",
  "network": "regtest",
  "assetId": "bitcoin:btc",
  "amountAtomic": "2500000",
  "recipientId": "rcp_...",
  "expiresAt": "2026-07-18T07:00:00.000Z"
}
```

FiberPass rejects any recipient, amount, asset, rail, network, invoice expiry,
or encoded invoice mismatch before execution. LNURL min/max sendable bounds are
also checked using exact integers.

## Calendar Rules

Schedules support `once`, `daily`, `weekly`, `monthly`, and `custom` cadences.

- Daily and weekly schedules preserve local wall-clock time in the configured
  IANA time zone across daylight-saving changes.
- Monthly schedules preserve the original local day. A day beyond the target
  month is clamped to month end, then restored when a later month supports the
  anchor day. For example, January 31 advances to February 28 and then March 31.
- DST gaps and overlaps use Temporal's compatible disambiguation: a missing
  local time moves forward by the gap and an overlap selects the earlier
  instant.
- Custom cadence is a fixed elapsed interval from 1 second through 365 days.

Schedule calculation is independent from resolution, execution, and retry.
Retries never advance the due time.

## Executors And Custody

`nwc` schedules require an active NIP-47 connection scoped to the wallet or
pass, `unattended` mode, a wallet-enforced allowance proof, `pay_invoice`, and
`lookup_invoice`. FiberPass cannot turn an interactive connection into cloud
auto-pay.

`btcpay` schedules use an active wallet/pass-scoped self-hosted BTCPay
connection. `fiber` schedules resolve through a supported endpoint and retain
the existing Fiber charge reservation and reconciliation ledger.

`maxFeeAtomic` is enforced only by the BTCPay executor. NWC and Fiber schedule
creation rejects a non-zero fee cap instead of presenting an unenforced policy.

The pass asset must match the destination and executor. Lightning currently
uses `bitcoin:btc`; Fiber currently uses `ckb:ckb`.

## API

All routes require wallet authentication. Creation routes also require an
`Idempotency-Key` header containing 8 to 160 characters.

- `POST /v2/sessions/:id/payment-destinations`
- `POST /v2/sessions/:id/payment-schedules`
- `GET /v2/sessions/:id/payment-schedules`
- `POST /v2/payment-schedules/:id/control` with `pause`, `resume`, or `revoke`
- `POST /v2/payment-schedules/sync`

A matching creation replay returns the original destination or schedule. A key
reused with different input returns a conflict. Control actions are themselves
idempotent.

Pause and revoke prevent new occurrences. Already-submitted uncertain payments
continue reconciliation so an external success cannot remain unaccounted.
Revoking an occurrence that has not reached an executor releases its exact pass
reservation.

## Operations And Validation

Run migrations before starting API and worker processes. Migration `009` adds
the schedule, occurrence, request-hash, and configuration-idempotency indexes.
The payment worker and `/cron/payment-worker` both run fresh-request schedules.

```bash
npm run build
npm test
SCHEDULE_TEST_MONGODB_URI='mongodb://127.0.0.1:27018/?replicaSet=rs0&directConnection=true' npm run test:schedules
```

The integration suite races eight workers, executes three fresh Lightning
occurrences, forces an unknown NWC result, verifies lookup-before-retry, and
checks pause, revoke, pass pause, depletion, expiry, occurrence limit, exact
spend, request-hash uniqueness, and absence of raw requests at rest.
