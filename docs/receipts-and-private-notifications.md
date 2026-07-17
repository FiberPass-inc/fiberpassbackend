# Receipts And Private Notifications

FiberPass records payment evidence independently of contact channels. A payment
does not require an email address, Nostr public key, SMTP server, or Nostr relay.
Notification delivery is best-effort and cannot change settlement state.

## Immutable receipt contract

Successful direct charges, scheduled occurrences, and settled metered usage
events create a `PaymentReceipt` in the transaction that finalizes accounting. The
receipt contains:

- a deterministic receipt id and SHA-256 receipt hash;
- the charge-attempt, occurrence, or usage-event source id and settlement id;
- rail, network, asset id, exact atomic-unit amount, and exact fee when known;
- terminal status, settlement time, payment hash, and public network proof.

The hash covers the ordered v1 receipt fields, including explicit nulls for
optional fields. Receipt fields are immutable in the model. A duplicate source
may replay only when its complete hash matches; conflicting settlement data
aborts the accounting transaction.

Contact deletion does not delete or alter receipts. Authenticated users can
list them with `GET /v2/receipts` and download receipts plus delivery status
metadata with `GET /v2/receipts/export`.

## Optional endpoint lifecycle

An authenticated wallet may configure multiple receipt endpoints for one of
its recipients:

- `POST /v2/notification-endpoints` creates an email or Nostr endpoint.
- `GET /v2/notification-endpoints` lists the wallet's endpoint state.
- `POST /v2/notification-endpoints/:endpointId/revoke` revokes an endpoint.
- `DELETE /v2/notification-endpoints/:endpointId` removes its contact data.
- `POST /v2/notification-endpoints/unsubscribe` consumes a receipt-only
  unsubscribe token without requiring wallet authentication.

Receipt unsubscribe tokens are HMAC-separated with the
`receipt-unsubscribe:v1` purpose. They are not recipient claim tokens and
cannot bind or change a payment destination. `NOTIFICATION_TOKEN_SECRET` must
contain at least 32 random characters in production.

Endpoint revocation, unsubscribe, contact deletion, and endpoint deletion clear
the contact value and cancel queued deliveries. They never delete payment
evidence.

## Delivery and retry isolation

After settlement commits, FiberPass creates at most one `NotificationDelivery`
per receipt and active endpoint. The queue record contains ids, channel, state,
attempt counts, lease timestamps, a sanitized failure code, and an optional
remote event reference. It never stores a rendered message, contact value,
wallet credential, invoice, preimage, claim token, or unsubscribe token.

Workers claim deliveries with a lease and use exponential retry. The fifth
failed attempt is terminal. Transport errors are reduced to a fixed public
failure message so provider errors cannot persist a contact address or private
payment material. Delivery exceptions are caught outside settlement; a failed
email or relay cannot turn a successful payment into a failed payment.

Terminal delivery metadata expires after
`NOTIFICATION_DELIVERY_RETENTION_DAYS` (90 days by default). Immutable receipts
remain available for financial history and export.

## Email minimization

Receipt emails contain only terminal status, exact amount and known fee, rail
and network, receipt id and hash, public network proof, and the receipt-only
notification-management link. They do not include wallet ids, payment
requests, invoices, preimages, connector credentials, or claim tokens.

SMTP remains optional. If it is unavailable, the delivery retries while the
receipt remains available in-app.

## Private Nostr delivery

Nostr receipt messages use the current private direct-message construction:

- a kind `14` chat rumor;
- NIP-44 v2 encryption;
- a kind `13` seal;
- a fresh-key kind `1059` NIP-59 gift wrap.

The public relay event exposes the recipient `p` tag required for routing but
does not expose receipt text, sender identity, the real message timestamp, or
the inner event kind. FiberPass publishes only to the one-to-three inbox relays
configured by the recipient, matching NIP-17's kind `10050` inbox guidance.
Relay DNS is resolved through the same private/reserved-address policy used for
webhook protection and pinned into the WebSocket connection. Delivery succeeds
only after at least one configured relay returns a positive `OK` acknowledgement.

Canonical specifications:

- [NIP-17 private direct messages](https://github.com/nostr-protocol/nips/blob/master/17.md)
- [NIP-44 versioned encryption](https://github.com/nostr-protocol/nips/blob/master/44.md)
- [NIP-59 gift wrap](https://github.com/nostr-protocol/nips/blob/master/59.md)

`NOSTR_NOTIFICATION_SECRET_KEY` is a dedicated service messaging key, not a
wallet key or seed. Nostr delivery remains disabled until that 32-byte hex key
is configured. Production relays must use `wss`; insecure loopback relays are a
test-only option.

## Required operations

Run migration `011-create-receipt-and-notification-models` before enabling the
worker. Configure:

```text
NOTIFICATION_TOKEN_SECRET=<at least 32 random characters>
NOTIFICATION_DELIVERY_RETENTION_DAYS=90
NOTIFICATION_DELIVERY_TIMEOUT_MS=15000
NOSTR_NOTIFICATION_SECRET_KEY=<optional 32-byte hex service key>
NOSTR_NOTIFICATION_ALLOW_INSECURE_LOCAL_RELAY=false
```

The payment worker and `/cron/payment-worker` both process private receipt
deliveries. Run `npm run test:receipts` for the database-backed fanout, retry,
unsubscribe, export, privacy, and retention suite.
