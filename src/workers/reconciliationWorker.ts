import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { runReconciliationWorkerOnce } from '../services/reconciliation.service.js';
import { acquireWorkerLease, recordWorkerHeartbeat, releaseWorkerLease } from '../services/workerRuntime.service.js';

const workerId = process.env.RECONCILIATION_WORKER_ID?.trim() || 'fiberpass-reconciliation-worker';
const startedAt = new Date();
const leaseKey = 'worker:reconciliation:batch';
let stopping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLoop(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { autoIndex: false });
  await recordWorkerHeartbeat({ workerId, kind: 'reconciliation', startedAt });
  logger.info('reconciliation_worker_started', {
    workerId,
    intervalMs: env.RECONCILIATION_WORKER_INTERVAL_MS,
    batchSize: env.RECONCILIATION_WORKER_BATCH_SIZE
  });

  while (!stopping) {
    let acquired = false;
    try {
      acquired = await acquireWorkerLease({ leaseKey, ownerId: workerId, ttlMs: env.WORKER_LEASE_TTL_MS });
      if (acquired) {
        const result = await runReconciliationWorkerOnce({
          workerId,
          limit: env.RECONCILIATION_WORKER_BATCH_SIZE
        });
        await recordWorkerHeartbeat({ workerId, kind: 'reconciliation', success: true, startedAt, metrics: { ...result } });
        if (Object.values(result).some((value) => value > 0)) {
          logger.info('reconciliation_worker_batch_processed', { workerId, ...result });
        }
      } else {
        await recordWorkerHeartbeat({ workerId, kind: 'reconciliation', startedAt, metrics: { leaseAcquired: false } });
      }
    } catch (error) {
      logger.error('reconciliation_worker_batch_failed', { workerId, error });
      await recordWorkerHeartbeat({
        workerId,
        kind: 'reconciliation',
        status: 'degraded',
        errorCode: error instanceof Error ? error.name : 'RECONCILIATION_WORKER_FAILED',
        startedAt
      }).catch(() => undefined);
    } finally {
      if (acquired) await releaseWorkerLease(leaseKey, workerId).catch(() => undefined);
    }

    await sleep(env.RECONCILIATION_WORKER_INTERVAL_MS);
  }

  await recordWorkerHeartbeat({ workerId, kind: 'reconciliation', status: 'stopping', startedAt }).catch(() => undefined);
  await mongoose.disconnect();
  logger.info('reconciliation_worker_stopped', { workerId });
}

process.on('SIGINT', () => {
  stopping = true;
});

process.on('SIGTERM', () => {
  stopping = true;
});

runLoop().catch((error) => {
  logger.error('reconciliation_worker_crashed', { workerId, error });
  process.exit(1);
});
