import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { normalizePaymentWorkerId, runPaymentWorkerOnce } from '../services/automation.service.js';
import { runDueSessionPayouts, runPayoutReceiptNotifications, runScheduledLiquidityPreparation } from '../services/session.service.js';

const workerId = normalizePaymentWorkerId(process.env.PAYMENT_WORKER_ID);
let stopping = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runLoop(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI);
  logger.info('payment_worker_started', { workerId, intervalMs: env.PAYMENT_WORKER_INTERVAL_MS, batchSize: env.PAYMENT_WORKER_BATCH_SIZE });

  while (!stopping) {
    try {
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
    } catch (error) {
      logger.error('payment_worker_batch_failed', { workerId, error });
    }

    await sleep(env.PAYMENT_WORKER_INTERVAL_MS);
  }

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
