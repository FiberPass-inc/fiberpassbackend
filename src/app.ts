import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { env, isProduction } from './config/env.js';
import { PAYMENT_CONTRACT_VERSION } from './domain/payment.js';
import { ApiError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { createRateLimitMiddleware } from './middleware/rateLimit.middleware.js';
import { requestContext } from './middleware/requestContext.middleware.js';
import { securityHeaders } from './middleware/securityHeaders.middleware.js';
import { appsRouter } from './routes/apps.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { fiberRouter } from './routes/fiber.routes.js';
import { sessionsRouter } from './routes/sessions.routes.js';
import { walletRouter } from './routes/wallet.routes.js';
import { runPaymentWorkerOnce } from './services/automation.service.js';
import { runReconciliationWorkerOnce } from './services/reconciliation.service.js';
import { runDueSessionPayouts, runScheduledLiquidityPreparation } from './services/session.service.js';
import { runWebhookWorkerOnce } from './services/webhook.service.js';
import { getWorkerReadiness } from './services/workerRuntime.service.js';

let mongoConnectionPromise: Promise<typeof mongoose> | undefined;

function parseCorsOrigin(origin: string): boolean | string[] {
  if (origin === '*') return true;
  return origin.split(',').map((entry) => entry.trim()).filter(Boolean);
}

export async function connectDatabase(): Promise<typeof mongoose> {
  if (mongoose.connection.readyState === 1) return mongoose;
  if (!mongoConnectionPromise) {
    mongoConnectionPromise = mongoose.connect(env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 8000 }).catch((error) => {
      mongoConnectionPromise = undefined;
      logger.error('mongo_connection_failed', {
        error: error instanceof Error ? error.message : error
      });
      throw error;
    });
  }
  return mongoConnectionPromise;
}

function verifyCronRequest(request: Request): boolean {
  if (!env.CRON_SECRET) return true;
  return request.headers.authorization === 'Bearer ' + env.CRON_SECRET;
}

async function runPaymentCron() {
  const liquidityPreparation = await runScheduledLiquidityPreparation({ limit: env.PAYMENT_WORKER_BATCH_SIZE });
  const scheduledPayouts = await runDueSessionPayouts({ limit: env.PAYMENT_WORKER_BATCH_SIZE });
  const automationPayments = await runPaymentWorkerOnce({
    workerId: 'vercel-cron-payment-worker',
    limit: env.PAYMENT_WORKER_BATCH_SIZE
  });
  const webhookDeliveries = await runWebhookWorkerOnce({
    workerId: 'vercel-cron-webhook-worker',
    limit: env.WEBHOOK_WORKER_BATCH_SIZE
  });
  const reconciliation = await runReconciliationWorkerOnce({
    workerId: 'vercel-cron-reconciliation-worker',
    limit: env.PAYMENT_WORKER_BATCH_SIZE
  });
  return { liquidityPreparation, scheduledPayouts, automationPayments, webhookDeliveries, reconciliation };
}

export const app = express();

if (env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(requestContext);
app.use(securityHeaders);
app.use(cors({
  origin: parseCorsOrigin(env.FRONTEND_ORIGIN),
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'Last-Event-ID'],
  exposedHeaders: ['X-FiberPass-Contract-Version']
}));
app.use(express.json({ limit: env.REQUEST_BODY_LIMIT }));

app.use((request, response, next) => {
  response.setHeader('X-FiberPass-Contract-Version', request.path.startsWith('/v2') ? PAYMENT_CONTRACT_VERSION : '1.0');
  next();
});

function sendMeta(request: Request, response: Response): void {
  response.json({
    service: 'fiberpass-api',
    mode: 'product',
    contractVersion: request.originalUrl.startsWith('/v2') ? PAYMENT_CONTRACT_VERSION : '1.0',
    paymentContracts: {
      current: PAYMENT_CONTRACT_VERSION,
      amounts: 'canonical-atomic-unit-strings',
      legacyV1Projection: 'non-negative-safe-integer-minor-units'
    },
    fiber: {
      provider: env.FIBER_PROVIDER,
      network: env.FIBER_NETWORK,
      rpcConfigured: Boolean(env.FIBER_RPC_URL)
    }
  });
}

async function sendReadiness(_request: Request, response: Response): Promise<void> {
  try {
    await connectDatabase();
    const workers = await getWorkerReadiness(env.WORKER_HEARTBEAT_STALE_MS);
    const mongoReady = mongoose.connection.readyState === 1;
    const readiness = buildApiReadiness(mongoReady, workers);
    response.status(readiness.ready ? 200 : 503).json(readiness);
  } catch {
    response.status(503).json(buildApiReadiness(false, { ready: false, workers: [] }));
  }
}

export function buildApiReadiness(
  mongoReady: boolean,
  workers: { ready: boolean; workers: unknown[]; staleAfterMs?: number }
) {
  return {
    ready: mongoReady && workers.ready,
    service: 'fiberpass-api',
    dependencies: {
      mongo: mongoReady ? 'ready' : 'unavailable',
      workers
    },
    at: new Date().toISOString()
  };
}

app.get('/health/live', (_request, response) => {
  response.json({ alive: true, service: 'fiberpass-api', at: new Date().toISOString() });
});
app.get('/health/ready', sendReadiness);
app.get('/health', sendReadiness);

app.get('/health/workers', async (_request, response) => {
  try {
    await connectDatabase();
    const readiness = await getWorkerReadiness(env.WORKER_HEARTBEAT_STALE_MS);
    response.status(readiness.ready ? 200 : 503).json(readiness);
  } catch {
    response.status(503).json({ ready: false, workers: [], error: 'WORKER_READINESS_UNAVAILABLE' });
  }
});

app.get('/cron/payment-worker', (_request, response) => {
  response
    .status(405)
    .setHeader('Allow', 'POST')
    .json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST to run the payment worker command.' } });
});

app.use(async (_request, _response, next) => {
  try {
    await connectDatabase();
    next();
  } catch (error) {
    next(error);
  }
});

app.use(createRateLimitMiddleware({ windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_GLOBAL_MAX, keyPrefix: 'global' }));

app.get('/meta', sendMeta);
app.get('/v1/meta', sendMeta);
app.get('/v2/meta', sendMeta);
app.use(fiberRouter);
app.use('/v1', fiberRouter);
app.use('/v2', fiberRouter);

app.post('/cron/payment-worker', async (request, response, next) => {
  try {
    if (!verifyCronRequest(request)) {
      response.status(401).json({ error: { code: 'CRON_UNAUTHORIZED', message: 'Invalid cron authorization.' } });
      return;
    }
    response.json(await runPaymentCron());
  } catch (error) {
    next(error);
  }
});

app.use(authRouter);
app.use(appsRouter);
app.use(sessionsRouter);
app.use(walletRouter);
app.use('/v1', authRouter);
app.use('/v1', appsRouter);
app.use('/v1', sessionsRouter);
app.use('/v1', walletRouter);
app.use('/v2', authRouter);
app.use('/v2', appsRouter);
app.use('/v2', sessionsRouter);
app.use('/v2', walletRouter);

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  if (error instanceof ZodError) {
    response.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request payload failed validation.',
        details: isProduction ? undefined : error.issues
      }
    });
    return;
  }

  if (error instanceof ApiError) {
    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        details: isProduction ? undefined : error.details
      }
    });
    return;
  }

  logger.error('unhandled_request_error', { error });
  response.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Unexpected FiberPass API error.'
    }
  });
});

export default app;
