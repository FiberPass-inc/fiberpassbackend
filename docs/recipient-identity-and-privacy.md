# Recipient Identity And Privacy

FiberPass keeps authentication, payment delivery, and optional contact data in
separate records. An authenticated wallet proves payer control. An email or
Nostr channel can deliver a claim or notification, but never proves control of
a wallet.

## Data Boundaries

| Record | Purpose | Security meaning |
| --- | --- | --- |
| `WalletPrincipal` | Connected payer wallet and authentication proof | Wallet control |
| `RecipientIdentity` | Stable recipient reference owned by a pass or app | No wallet proof |
| `PaymentDestination` | Address, one-time invoice, or reusable endpoint | Delivery instruction unless separately wallet-signed |
| `ClaimChannel` | Optional email or Nostr claim delivery | Contact delivery only |
| `NotificationEndpoint` | Optional receipt delivery | Contact delivery only |
| `RecipientClaim` | One-time authority to bind a destination | Narrow destination-binding authority |

`PaymentDestination.verificationScope` makes the distinction explicit.
`delivery_instruction` confirms where a recipient asked to be paid;
`wallet_control` is reserved for a separate wallet signature. Claiming an
email link records contact delivery and a delivery instruction, not wallet
ownership.

## Claim Lifecycle

Claim tokens use 32 random bytes. Only the SHA-256 token hash is stored. A claim
can move once from `pending` to `claimed`, `expired`, or `revoked`.
Destination validation happens before an atomic transaction consumes the claim,
replaces any previous active destination, and updates the legacy session
projection. Concurrent requests therefore cannot bind two destinations.

Owners can rotate pending links with
`POST /sessions/:id/recipient-invites/resend` or revoke one with
`POST /sessions/:id/recipient-claims/:claimId/revoke`. Expired, consumed, and
revoked tokens cannot change a destination.

## Repeated Payments

CKB addresses and recipient-hosted endpoints are reusable. A Fiber invoice is
amount-specific and one-time, so subscription and recurring-release passes
reject it as their stored destination. Fresh request resolution for additional
reusable payment protocols belongs to the scheduled-payment resolver work; the
backend will not silently reuse a stale invoice in the meantime.

## Privacy API

- `GET /privacy/export` requires wallet authentication and returns the
  wallet-owned recipient contact records plus immutable payment proof
  references.
- `DELETE /privacy/contact-data` removes contact values and hashes, revokes
  pending contact claims, and removes legacy embedded email fields.
- Payment attempts, network proof ids, and provider correlation ids are not
  deleted by contact removal.

Both routes are also available under `/v1` and `/v2`.

## Migration And Compatibility

Migration `005-separate-recipient-identity-data` idempotently imports existing
wallets, embedded session recipients, claim tokens, and automation recipients.
Legacy embedded recipient fields remain as an API and worker compatibility
projection. New pass and automation-recipient writes update the separated
records transactionally.
