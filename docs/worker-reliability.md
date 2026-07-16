# Worker Reliability and Deployment

FiberPass requires four independently supervised services from the same build artifact:

| Service | Start command | Responsibility |
| --- | --- | --- |
| API | `npm start` | HTTP API, commands, reads, SSE replay |
| Payments | `npm run start:worker:payments` | scheduled payouts, receipts, queued payment jobs |
| Reconciliation | `npm run start:worker:reconciliation` | stale-lock recovery, expiry, ledger reconciliation |
| Webhooks | `npm run start:worker:webhooks` | signed webhook delivery and retries |

The files in `deploy/railway/` are service-specific Railway configs. Point each Railway service at its matching config file and share the same production environment variables. `railway.json` is the API default; it no longer starts a payment worker in place of the API.

## Supervision and readiness

Each worker writes a Mongo heartbeat after every bounded batch and records its latest counters. `GET /health/ready` and `GET /health/workers` return HTTP 503 unless payments, reconciliation, and webhooks each have a fresh non-stopping instance. `GET /health/live` only proves the API process is alive. Set `WORKER_HEARTBEAT_STALE_MS` above the longest normal batch duration and below the alerting threshold.

Workers handle `SIGINT` and `SIGTERM`, finish the current bounded batch, record `stopping`, and disconnect Mongo. The platform restart policy handles unexpected exits.

## Locks and recovery

- Payment jobs use an atomic `queued/retrying -> locked` claim. Reconciliation returns stale `locked/processing` jobs to `retrying`, or fails jobs whose attempt budget is exhausted.
- Charge attempts use reservation leases. A stale attempt is released only when provider submission never began. Submitted or uncertain outcomes retain their reserve for provider reconciliation.
- Recipient payouts use an atomic array-element claim and reclaim `processing` work after its timeout.
- Webhook deliveries use an atomic `queued/retrying -> delivering` claim. Reconciliation requeues an abandoned delivery lock or fails it at the attempt limit.
- Reconciliation batches use a Mongo lease, so multiple supervised replicas do not execute the same sweep concurrently. An expired lease can be acquired by another replica.

## Delivery guarantees

Mongo state transitions, balance reservations, and idempotency keys provide exactly-once ledger effects. External Fiber payments and webhook HTTP requests are at-least-once operations around a persisted outcome: clients must use the provided payment idempotency key, and webhook consumers must deduplicate `x-fiberpass-delivery`.

Live overview updates are stored in Mongo for seven days. Clients create a short-lived credential with `POST /events/ticket`, open `GET /events?ticket=...`, and reconnect with `Last-Event-ID` or `?cursor=`; long-lived bearer tokens never enter event URLs. The API replays later events, including events produced by another process. Clients should still poll side-effect-free `GET /sessions` at a low frequency when streaming is unavailable.
