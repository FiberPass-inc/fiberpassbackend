# Metered Micropayments And Safe Batching

FiberPass metered payments let an owner-approved application or agent report
repeatable usage without receiving an unrestricted wallet credential. The
wallet owner creates a grant against one pass and one reusable recipient
destination. Every accepted event is reserved and receipted individually, even
when several small events settle as one channel payment.

Metered events and scheduled payments are separate workflows. A usage event is
driven by measured application activity and a stable external id. A schedule is
driven by a due time and occurrence id.

## Grant Contract

Only the authenticated wallet owner can create or revoke a grant. The pass must
belong to the same wallet as the app, bind that app and owner explicitly,
include charges:create, allow microcharges, remain active and unexpired, and use
the same immutable asset id.

A grant binds app, owner, pass, recipient, reusable destination, rail, network,
asset, executor, scoped connection, policy limits, batching limits, and expiry.
Lightning grants use an unattended wallet-limited NWC connection or scoped
self-hosted BTCPay. Fiber grants use the Fiber executor. On-chain Bitcoin and
CKB are excluded from automatic micro-batching because channel rails are the
economic path for repeatable small payments.

All public amounts are canonical base-10 atomic-unit strings. The current pass
ledger retains legacy safe-integer mirrors, so one event or batch is rejected
if it exceeds that compatibility range. No floating-point value is used to
reserve, add, compare, batch, or finalize usage.

## Event Acceptance

An app submits:

    {
      "grantId": "fp_mg_...",
      "externalId": "usage:customer-42:2026-07-17T12:00:00Z",
      "amountAtomic": "2500",
      "type": "Inference tokens",
      "policyReference": "pricing-v3",
      "metadata": { "units": "500" }
    }

The appId and externalId pair is globally unique. Its request fingerprint
includes the grant, exact amount, type, and policy reference. An equivalent
replay returns the original event and receipt. Reusing the external id with
different terms returns USAGE_EVENT_IDEMPOTENCY_CONFLICT.

Acceptance runs in one MongoDB transaction:

1. Recheck the owner-bound app grant, pass state, expiry, and exact asset.
2. Enforce the per-event and remaining grant limits.
3. Enforce spent plus reserved plus event is no greater than the pass limit.
4. Increment the grant fixed-window rate counter.
5. Reserve the exact amount in the grant and pass.
6. Assign the event to one homogeneous bounded batch.
7. Write the immutable event, initial receipt, and charge-attempt audit record.

Concurrent submissions contend on the grant, rate counter, pass, and batch.
Unique indexes prevent duplicate external ids and multiple open batches for the
same complete batch identity.

The immutable event payload contains app, owner, pass, recipient, destination,
rail, network, asset, exact amount, external id, policy reference, batch id, and
acceptance time. Settlement updates only state and proof fields.

## Immediate And Batched Settlement

An event whose amount meets the immediate threshold gets a one-event queued
batch. Smaller events enter the current collecting batch. A collecting batch
closes and queues when its exact total reaches the threshold or batch maximum,
its event-count maximum is reached, or its collection delay expires.

The batch key commits to owner, app, grant, pass, recipient, destination, rail,
network, asset, executor, and scoped connection. A batch cannot mix any of
those values. The batch total must equal the exact sum of its events before
finalization.

## Worker And Recovery

The supervised payment worker claims due batches with a bounded lease. It
rechecks grant and destination state, resolves one fresh amount-bound request
for the exact batch total, and persists only the request hash and non-secret
payment correlation data.

Execution uses the batch id as the provider idempotency key. The executor marks
the batch submitted before the remote payment can become ambiguous:

- NWC persists and looks up its payment by connection and batch id.
- BTCPay persists and looks up its payment by connection and batch id.
- Fiber persists the connector correlation reference and uses connector lookup.

After a crash, a replacement worker performs provider lookup before resolving
or paying again. A pending or unknown result retains all reservations and moves
the batch to uncertain. Retry backoff is bounded. A confirmed success moves
every event reservation to spent in one transaction and gives each receipt the
same settlement proof. A confirmed or terminal failure releases every event
reservation in one transaction. There is no partial local debit for a batch.

State flow:

    collecting -> queued -> processing -> succeeded
                             |
                             +-> retrying -> uncertain -> provider lookup
                                                        -> succeeded or failed

## Revocation And Expiry

Revocation immediately blocks new events. Collecting, queued, or retrying
batches with no provider submission are released deterministically. A submitted
batch is not discarded: the worker continues reconciliation so a real external
payment can never be represented as unpaid locally.

Grant expiry has the same new-event behavior. A depleted grant remains visible
with exact spent and remaining values.

## Receipts

Every accepted event receives a stable receipt id immediately. Before
settlement the receipt reports reserved or settling. After settlement it
contains the event and batch ids, exact asset and amount, settlement status and
time, payment-request hash, proof kind, and non-secret proof reference.

Raw BOLT11 or Fiber requests and Lightning preimages are not persisted on
events or batches. Notification delivery remains optional and separate.

## API

Wallet-owner routes:

- GET /apps/:appId/metered-grants
- POST /apps/:appId/metered-grants
- POST /apps/:appId/metered-grants/:grantId/revoke
- POST /apps/:appId/usage-events
- GET /apps/:appId/usage-events?grantId=...
- GET /apps/:appId/metered-batches?grantId=...

Scoped app-key routes require payments:charge:

- GET /apps/:appId/automation/metered-grants
- POST /apps/:appId/automation/usage-events
- GET /apps/:appId/automation/usage-events?grantId=...
- GET /apps/:appId/automation/metered-batches?grantId=...

The generic API rate limiter applies before the grant fixed-window counter.
Provider, connection, invoice, and wallet secrets are never returned.

## Operations And Validation

Migration 010-create-metered-payment-models creates the required unique and
worker indexes. Run migrations before deploying API or payment workers.

Focused validation:

    npm run build
    npm test
    METERED_TEST_MONGODB_URI=mongodb://127.0.0.1:27018/?replicaSet=rs0 npm run test:metered

The integration suite covers concurrent duplicate submission, high-volume exact
totals, bounded homogeneous batches, competing workers, process loss after
provider submission, lookup recovery without a second execution, terminal
failure release, revocation cleanup, and rate enforcement.
