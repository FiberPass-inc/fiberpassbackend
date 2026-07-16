# Production Operations Runbook

## Release sequence

1. Confirm the API, payments, reconciliation, and webhook services use the same commit and environment.
2. Take an on-demand Mongo snapshot and record the snapshot identifier.
3. Run `npm run start:migrate` once as a release job. Migrations are versioned and recorded in the `migrations` collection; API and workers run with `autoIndex: false`.
4. Deploy the API, then payments, reconciliation, and webhooks.
5. Require `/health/live` and `/health/ready`, a test authentication challenge, and a no-value testnet workflow to pass before increasing traffic. Point the platform readiness probe at `/health/ready`.
6. Watch error rate, pending/uncertain charge counts, stale locks, and worker heartbeat age through the first full worker interval.

Do not run multiple migration jobs concurrently. A migration in `applying` state must be investigated before another deploy.

## Incident response

For a payment incident, stop payment execution first while keeping the API read path and reconciliation available. Record the deployment SHA, affected wallet/pass/job identifiers, provider correlation identifiers, and the last successful worker heartbeat. Never release an `uncertain` reservation until provider reconciliation proves failure.

Severity guide:

- Critical: unauthorized spend, incorrect balance/refund, leaked signing material, or internal-network webhook access.
- High: payment workers unavailable, stale locks above their recovery window, or readiness failing across replicas.
- Medium: delayed webhooks, emails, or live updates with ledger state intact.

Preserve audit logs and relevant provider responses. Do not paste private keys, bearer tokens, webhook secrets, or raw JoyID credentials into tickets or chat.

## Rollback

Application rollback is allowed only when the prior release understands every migration already applied. Database migrations are forward-only: create a corrective migration instead of editing migration history or manually deleting indexes. If the prior application cannot read the new schema, keep the new release stopped, restore the pre-release snapshot into an isolated database, validate counts and balances, then perform a controlled cutover.

After rollback, rerun readiness and compare wallet funding, session reserves, charge attempts, payment jobs, and webhook delivery counts against the incident record.

## Backup and restore

- Enable encrypted managed-Mongo continuous backups and point-in-time recovery.
- Take a snapshot before migrations and key rotations.
- Retain backups according to the custody and audit policy, with access limited to production operators.
- Test restoration at least quarterly into an isolated project using `mongorestore --drop` or the managed provider restore workflow.
- After restore, run migrations, verify required indexes, then reconcile a sampled set of wallet balances and pending jobs without enabling payment workers.

A restore is not complete until document counts, unique indexes, worker leases, pending reservations, and audit-log timestamps have been checked.

## Key rotation

Rotate one key class at a time and take a snapshot first.

- `WEBHOOK_SECRET_ENCRYPTION_KEY`: deploy dual-decrypt support before changing this key, re-encrypt every app secret, verify sample HMACs, then remove the old key. Never replace it directly while encrypted secrets still depend on it.
- App webhook signing secret: update the consumer secret manager and FiberPass configuration in a coordinated window. New attempts use the current app-level secret.
- `FIBERPASS_OPERATOR_PRIVATE_KEY`: pause vault payout workers, move authority on chain/configuration, update the operator lock hash and signer secret, run a bounded testnet payout, then resume.
- `FIBER_NODE_CKB_PRIVATE_KEY` and `FIBER_EXIT_SETTLEMENT_PRIVATE_KEY`: drain or pause Fiber/exit operations, rotate the corresponding funding/settlement identity, verify address and lock-hash configuration, then restore traffic.
- `CRON_SECRET`, Fiber gateway token, SMTP credentials, and app API keys: overlap old/new credentials where supported, verify use of the new credential, and revoke the old value.

Record who rotated the key, when, the affected environment, and non-secret fingerprints or public addresses.
