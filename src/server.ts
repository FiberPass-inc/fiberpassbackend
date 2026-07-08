import http from 'node:http';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { env, isProduction } from './config/env.js';
import { ApiError } from './lib/errors.js';
import { logger } from './lib/logger.js';
import { createRateLimitMiddleware } from './middleware/rateLimit.middleware.js';
import { requestContext } from './middleware/requestContext.middleware.js';
import { securityHeaders } from './middleware/securityHeaders.middleware.js';
import { appsRouter } from './routes/apps.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { demoRouter } from './routes/demo.routes.js';
import { sessionsRouter } from './routes/sessions.routes.js';
import { chargeRandomActiveSession, seedDemoData } from './services/session.service.js';

function parseCorsOrigin(origin: string): boolean | string[] {
  if (origin === '*') return true;
  return origin.split(',').map((entry) => entry.trim()).filter(Boolean);
}

const app = express();
if (env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(requestContext);
app.use(securityHeaders);
app.use(createRateLimitMiddleware({ windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_GLOBAL_MAX, keyPrefix: 'global' }));
app.use(cors({ origin: parseCorsOrigin(env.FRONTEND_ORIGIN), methods: ['GET', 'POST', 'OPTIONS'] }));
app.use(express.json({ limit: env.REQUEST_BODY_LIMIT }));

function sendMeta(_request: Request, response: Response): void {
  response.json({
    service: 'fiberpass-api',
    mode: env.DEMO_MODE ? 'demo' : 'product',
    demoMode: env.DEMO_MODE,
    fiber: {
      provider: env.FIBER_PROVIDER,
      network: env.FIBER_NETWORK,
      rpcConfigured: Boolean(env.FIBER_RPC_URL)
    }
  });
}

app.get('/meta', sendMeta);
app.get('/v1/meta', sendMeta);

app.get('/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'fiberpass-api',
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
    at: new Date().toISOString()
  });
});

app.use(authRouter);
app.use(appsRouter);
app.use(sessionsRouter);
app.use('/v1', authRouter);
app.use('/v1', appsRouter);
app.use('/v1', sessionsRouter);
if (env.DEMO_MODE) {
  app.use(demoRouter);
  app.use('/v1', demoRouter);
}

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

await mongoose.connect(env.MONGODB_URI);
if (env.DEMO_MODE) {
  await seedDemoData();
}

let demoTimer: NodeJS.Timeout | undefined;
if (env.DEMO_MODE && env.DEMO_AUTO_CHARGE) {
  demoTimer = setInterval(() => {
    chargeRandomActiveSession().catch((error) => logger.warn('demo_auto_charge_tick_skipped', { error }));
  }, env.DEMO_CHARGE_INTERVAL_MS);
}

const server = http.createServer(app);
server.listen(env.PORT, '0.0.0.0', () => {
  logger.info('api_listening', { port: env.PORT, demoMode: env.DEMO_MODE, fiberProvider: env.FIBER_PROVIDER, fiberNetwork: env.FIBER_NETWORK });
});

const shutdown = async () => {
  if (demoTimer) clearInterval(demoTimer);
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
