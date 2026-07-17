# Nostr Wallet Connect Lightning

FiberPass can connect to an existing Bitcoin Lightning wallet through Nostr
Wallet Connect (NIP-47). FiberPass does not create a seed, issue an address, or
hold the wallet's funds. The wallet remains the execution and balance authority.

## Pairing And Scope

An authenticated owner sends an NWC URI in the JSON body of
`POST /wallet/nwc-connections`. The URI must never be put in a query string,
email, issue, log, or analytics event because its `secret` parameter authorizes
the connection.

Each connection belongs to one explicit scope:

- `wallet`: the authenticated wallet owner;
- `pass`: one owned payment session;
- `app`: one active app owned by that wallet.

The backend validates the URI and relay URLs, loads and verifies the wallet's
signed NIP-47 information event, negotiates advertised methods, and prefers
NIP-44 v2 encryption. NIP-04 is retained only for compatible legacy wallets.
The NWC secret is encrypted with AES-256-GCM under
`NWC_SECRET_ENCRYPTION_KEY`. API responses contain connection identifiers,
capabilities, and non-secret fingerprints, never the URI, secret, relay URLs, or
raw Nostr keys.

A connection URI is single-use in FiberPass. Use separate connections for
separate scopes so revoking one app or pass does not expose or disable another.

## Interactive And Unattended Modes

`interactive` mode uses the permissions enforced by the connected wallet. The
wallet may still prompt, reject, rate-limit, or cap a payment.

NIP-47 does not define a standard API for proving a wallet allowance. FiberPass
therefore fails closed for `unattended` mode unless a signed `get_info` response
contains this wallet-enforced budget extension and the wallet advertises
`lookup_invoice`:

```json
{
  "budget": {
    "enforced": true,
    "unit": "msat",
    "total_budget": "100000",
    "used_budget": "25000",
    "renews_at": 1780000000
  }
}
```

All amounts are exact non-negative millisatoshi strings. A pasted allowance in
the pairing request, wallet description, or unsigned metadata is not accepted
as proof. A wallet without this extension can still be used interactively.
This task provides the bounded connection primitive; scheduling and recurring
payment orchestration are separate work packages.

## Invoice And Payment Safety

FiberPass accepts amount-bearing BOLT11 invoices only. Before execution it
validates the invoice signature/payee, Bitcoin network, exact millisatoshi
amount, payment hash, and expiry. It also requires the connected wallet to have
advertised every invoked method.

Payment requests require an idempotency key. FiberPass stores an invoice hash
and payment hash, not the raw invoice. A successful wallet response is accepted
only when its preimage hashes to the invoice payment hash; the preimage is then
discarded. Receipts expose the payment hash and signed Nostr request/response
event identifiers without exposing the preimage.

A timeout is an `uncertain` outcome, never a failed payment. Repeating the same
request first calls `lookup_invoice` with the persisted payment hash. FiberPass
does not submit `pay_invoice` again until the prior outcome is known, preventing
a network timeout from becoming a duplicate payment.

## API

All routes require wallet bearer authentication and are also mounted under
`/v1` and `/v2`.

- `POST /wallet/nwc-connections`: pair and scope a connection.
- `GET /wallet/nwc-connections`: list non-secret connection metadata.
- `POST /wallet/nwc-connections/:connectionId/balance/sync`: request a fresh
  wallet balance when `get_balance` is advertised.
- `POST /wallet/nwc-connections/:connectionId/payments`: pay a BOLT11 invoice;
  send `Idempotency-Key` or `idempotencyKey`.
- `GET /wallet/nwc-connections/:connectionId/payments/:paymentHash`: read and,
  when needed, reconcile one payment.
- `DELETE /wallet/nwc-connections/:connectionId`: destroy the server-side
  credential and disconnect the scope.

Deleting a FiberPass connection cannot guarantee that a wallet provider has
revoked the remote authorization. The response therefore tells the owner to
revoke the connection in the wallet as well.

## Deployment And Verification

Set a stable, randomly generated 32-byte `NWC_SECRET_ENCRYPTION_KEY` encoded as
64 hexadecimal characters or base64. Losing or replacing it makes stored
connections undecryptable. Production permits `wss://` public relays only;
`NWC_ALLOW_INSECURE_LOCAL_RELAY=true` is limited to local regtest development.
Resolved relay addresses are checked against private/link-local ranges and
pinned for the WebSocket connection.

Run the protocol and mocked-wallet checks with:

```bash
npm run test:nwc
```

The test wallet uses signed NIP-47 events over a local WebSocket relay and
covers NIP-44/NIP-04 negotiation, scoped pairing, exact payment proof,
idempotent replay, timeout reconciliation, allowance enforcement, encrypted
storage, and credential destruction. It does not substitute for a bounded
signet validation against the specific production wallet provider.
