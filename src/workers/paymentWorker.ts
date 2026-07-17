import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { normalizePaymentWorkerId, runPaymentWorkerOnce } from '../services/automation.service.js';
import { runDueSessionPayouts, runPayoutReceiptNotifications, runScheduledLiquidityPreparation } from '../services/session.service.js';
import { recordWorkerHeartbeat } from '../services/workerRuntime.service.js';
import { runDuePaymentSchedules } from '../services/paymentSchedule.service.js';
import { runMeteredPaymentWorker } from '../services/meteredPaymentWorker.service.js';

const workerId = normalizePaymentWorkerId(process.env.PAYMENT_WORKER_ID);
const startedAt = new Date();
let stopping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLoop(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { autoIndex: false });
  await recordWorkerHeartbeat({ workerId, kind: 'payments', startedAt });
  logger.info('payment_worker_started', { workerId, intervalMs: env.PAYMENT_WORKER_INTERVAL_MS, batchSize: env.PAYMENT_WORKER_BATCH_SIZE });

  while (!stopping) {
    try {
      const freshRequestSchedules = await runDuePaymentSchedules({
        workerId,
        limit: env.PAYMENT_WORKER_BATCH_SIZE
      });
      if (freshRequestSchedules.claimed > 0 || freshRequestSchedules.blocked > 0) {
        logger.info('fresh_request_schedules_processed', { workerId, ...freshRequestSchedules });
      }

      const meteredPayments = await runMeteredPaymentWorker({
        workerId,
        limit: env.PAYMENT_WORKER_BATCH_SIZE
      });
      if (meteredPayments.claimed > 0 || meteredPayments.released > 0) {
        logger.info('metered_payments_processed', { workerId, ...meteredPayments });
      }

      const liquidityPreparation = await runScheduledLiquidityPreparation({ limit: env.PAYMENT_WORKER_BATCH_SIZE });
      if (liquidityPreparation.processed > 0 || liquidityPreparation.failed > 0) {
        logger.info('scheduled_liquidity_prepared', { workerId, ...liquidityPreparation });
      }

      const scheduledPayouts = await runDueSessionPayouts({ limit: env.PAYMENT_WORKER_BATCH_SIZE });
      if (scheduledPayouts.processed > 0 || scheduledPayouts.failed > 0) {
        logger.info('scheduled_payouts_processed', { workerId, ...scheduledPayouts });
      }

      const receiptNotifications = await runPayoutReceiptNotifications({ limit: env.PAYMENT_WORKER_BATCH_SIZE });
      if (receiptNotifications.processed > 0 || receiptNotifications.failed > 0) {
        logger.info('payout_receipts_processed', { workerId, ...receiptNotifications });
      }

      const result = await runPaymentWorkerOnce({ workerId, limit: env.PAYMENT_WORKER_BATCH_SIZE });
      if (result.processed > 0) {
        logger.info('payment_worker_batch_processed', { workerId, ...result });
      }
      await recordWorkerHeartbeat({
        workerId,
        kind: 'payments',
        success: true,
        startedAt,
        metrics: { freshRequestSchedules, meteredPayments, liquidityPreparation, scheduledPayouts, receiptNotifications, payments: result }
      });
    } catch (error) {
      logger.error('payment_worker_batch_failed', { workerId, error });
      await recordWorkerHeartbeat({
        workerId,
        kind: 'payments',
        status: 'degraded',
        errorCode: error instanceof Error ? error.name : 'PAYMENT_WORKER_FAILED',
        startedAt
      }).catch(() => undefined);
    }

    await sleep(env.PAYMENT_WORKER_INTERVAL_MS);
  }

  await recordWorkerHeartbeat({ workerId, kind: 'payments', status: 'stopping', startedAt }).catch(() => undefined);
  await mongoose.disconnect();
  logger.info('payment_worker_stopped', { workerId });
}

process.on('SIGINT', () => {
  stopping = true;
});

process.on('SIGTERM', () => {
  stopping = true;
});

runLoop().catch((error) => {
  logger.error('payment_worker_crashed', { workerId, error });
  process.exit(1);
});
