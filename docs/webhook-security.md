# Webhook Security and Signature Contract

## Destination policy

Webhook configuration and every delivery require an `https://` URL on port 443. FiberPass rejects embedded URL credentials and destinations that resolve to loopback, private, carrier-grade NAT, link-local, multicast, unspecified, documentation, or cloud metadata address ranges. Every DNS answer must be public.

Delivery performs DNS validation again, then connects directly to the validated IP while retaining the original hostname for TLS certificate verification and the HTTP `Host` header. This prevents a second unvalidated DNS lookup during the request. Redirects are never followed; any 3xx response fails with `WEBHOOK_REDIRECT_FORBIDDEN`.

## Signing secret storage

Set `WEBHOOK_SECRET_ENCRYPTION_KEY` to a stable random 32-byte key encoded as 64 hexadecimal characters or base64. App webhook secrets are encrypted with AES-256-GCM and stored once on the app. Delivery records contain no plaintext or encrypted secret. Rotating an app secret changes signatures for all later attempts, so coordinate rotation with the consumer.

The configuration response returns a generated signing secret only when FiberPass creates one. It cannot be recovered later from the API. Store it in the consumer's secret manager.

## HMAC verification

Each request includes:

- `x-fiberpass-delivery`: stable delivery identifier used for deduplication;
- `x-fiberpass-event`: event type;
- `x-fiberpass-timestamp`: Unix timestamp in seconds;
- `x-fiberpass-signature`: `sha256=` followed by the lowercase HMAC digest.

The signed bytes are:

```text
<timestamp>.<raw-request-body>
```

Consumers must reject stale timestamps, compute HMAC-SHA256 with the app signing secret, compare in constant time, and deduplicate the delivery identifier. A 2xx response acknowledges delivery. Retryable network failures, timeouts, 408, 425, 429, and 5xx responses use bounded exponential backoff. Other 4xx responses and redirects fail without retry. Reconciliation recovers abandoned `delivering` locks and records an audit event.
