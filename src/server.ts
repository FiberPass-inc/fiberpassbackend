import http from 'node:http';
import mongoose from 'mongoose';
import { app, connectDatabase } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { runDueSessionPayouts, runScheduledLiquidityPreparation } from './services/session.service.js';

let paymentSchedulerRunning = false;
let paymentSchedulerTimer: NodeJS.Timeout | undefined;

async function runEmbeddedPaymentSchedulerTick(): Promise<void> {
  if (paymentSchedulerRunning) return;
  paymentSchedulerRunning = true;
  try {
    const liquidityPreparation = await runScheduledLiquidityPreparation({ limit: env.PAYMENT_WORKER_BATCH_SIZE });
    if (liquidityPreparation.processed > 0 || liquidityPreparation.failed > 0) {
      logger.info('api_scheduled_liquidity_prepared', { ...liquidityPreparation });
    }

    const scheduledPayouts = await runDueSessionPayouts({ limit: env.PAYMENT_WORKER_BATCH_SIZE });
    if (scheduledPayouts.processed > 0 || scheduledPayouts.failed > 0) {
      logger.info('api_scheduled_payouts_processed', { ...scheduledPayouts });
    }
  } catch (error) {
    logger.error('api_scheduled_payouts_failed', { error });
  } finally {
    paymentSchedulerRunning = false;
  }
}

function startEmbeddedPaymentScheduler(): void {
  if (paymentSchedulerTimer) return;
  paymentSchedulerTimer = setInterval(() => {
    void runEmbeddedPaymentSchedulerTick();
  }, env.PAYMENT_WORKER_INTERVAL_MS);
  paymentSchedulerTimer.unref?.();
  void runEmbeddedPaymentSchedulerTick();
}

await connectDatabase();

const server = http.createServer(app);
server.listen(env.PORT, '0.0.0.0', () => {
  logger.info('api_listening', { port: env.PORT, fiberProvider: env.FIBER_PROVIDER, fiberNetwork: env.FIBER_NETWORK });
  startEmbeddedPaymentScheduler();
});

const shutdown = async () => {
  if (paymentSchedulerTimer) clearInterval(paymentSchedulerTimer);
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await mongoose.disconnect();
};

process.on('SIGINT', () => {
  shutdown().finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  shutdown().finally(() => process.exit(0));
});
