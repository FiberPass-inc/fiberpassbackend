import assert from 'node:assert/strict';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { app, buildApiReadiness } from '../app.js';
import { readBearerToken, requireAuth, requireStreamTicket } from '../middleware/auth.middleware.js';
import { createRateLimitMiddleware, resetMemoryRateLimits } from '../middleware/rateLimit.middleware.js';
import { publicFiberReadiness } from '../routes/fiber.routes.js';

const live = await request(app).get('/health/live').expect(200);
assert.equal(live.body.alive, true);
assert.equal(live.headers['cache-control'], 'no-store');
assert.equal(live.headers['x-content-type-options'], 'nosniff');
assert.match(live.headers['content-security-policy'], /default-src 'none'/);
assert.equal(live.headers['x-fiberpass-contract-version'], '1.0');

const disabledGetCommand = await request(app).get('/cron/payment-worker').expect(405);
assert.equal(disabledGetCommand.headers.allow, 'POST');
assert.equal(disabledGetCommand.body.error.code, 'METHOD_NOT_ALLOWED');

const preflight = await request(app)
  .options('/apps/app-1/recipients/recipient-1')
  .set('Origin', 'http://localhost:3000')
  .set('Access-Control-Request-Method', 'PATCH')
  .set('Access-Control-Request-Headers', 'authorization,content-type')
  .expect(204);
assert.equal(preflight.headers['access-control-allow-origin'], 'http://localhost:3000');
assert.match(preflight.headers['access-control-allow-methods'], /PATCH/);
assert.match(preflight.headers['access-control-allow-headers'], /Authorization/i);

const queryOnlyRequest = {
  header: () => undefined,
  query: { token: 'long-lived-session-token' }
} as unknown as Request;
assert.equal(readBearerToken(queryOnlyRequest), null);

const headerRequest = {
  header: (name: string) => name.toLowerCase() === 'authorization' ? 'Bearer header-token' : undefined,
  query: {}
} as unknown as Request;
assert.equal(readBearerToken(headerRequest), 'header-token');

function errorResponse(error: unknown, _request: Request, response: Response, _next: NextFunction): void {
  const apiError = error as { statusCode?: number; code?: string; message?: string };
  response.status(apiError.statusCode ?? 500).json({
    error: { code: apiError.code ?? 'ERROR', message: apiError.message ?? 'Request failed.' }
  });
}

const authProbe = express();
authProbe.get('/private', requireAuth, (_request, response) => response.json({ ok: true }));
authProbe.get('/events', requireStreamTicket, (_request, response) => response.json({ ok: true }));
authProbe.use(errorResponse);
const rejectedQueryBearer = await request(authProbe).get('/private?token=long-lived-session-token').expect(401);
assert.equal(rejectedQueryBearer.body.error.code, 'AUTH_REQUIRED');
const rejectedBearerStream = await request(authProbe).get('/events?token=long-lived-session-token').expect(401);
assert.equal(rejectedBearerStream.body.error.code, 'STREAM_TICKET_REQUIRED');

resetMemoryRateLimits();
const limited = express();
limited.use(createRateLimitMiddleware({
  windowMs: 60_000,
  max: 2,
  keyPrefix: 'hardening-test',
  store: 'memory',
  keyGenerator: () => 'same-client'
}));
limited.get('/limited', (_request, response) => response.json({ ok: true }));
limited.use(errorResponse);
await request(limited).get('/limited').expect(200);
await request(limited).get('/limited').expect(200);
const limitedResponse = await request(limited).get('/limited').expect(429);
assert.equal(limitedResponse.body.error.code, 'RATE_LIMIT_EXCEEDED');
assert.equal(limitedResponse.headers['ratelimit-remaining'], '0');

const notReady = buildApiReadiness(true, { ready: false, workers: [] });
assert.equal(notReady.ready, false);
assert.equal(notReady.dependencies.mongo, 'ready');
const mongoUnavailable = buildApiReadiness(false, { ready: true, workers: [] });
assert.equal(mongoUnavailable.ready, false);
assert.equal(mongoUnavailable.dependencies.mongo, 'unavailable');

const detailedReadiness = {
  configured: true,
  reachable: true,
  provider: 'rpc',
  network: 'testnet',
  checkedAt: new Date().toISOString(),
  readiness: 'ready',
  paymentExecution: { status: 'ready', canSendPayments: true, reason: 'ready' },
  rpcUrl: 'https://operator-secret.example',
  apiKeyConfigured: true,
  peerIdConfigured: true,
  operator: { minPeers: 1 },
  peers: { connectedCount: 5 },
  channels: { activeCount: 2 },
  alerts: []
} as unknown as Parameters<typeof publicFiberReadiness>[0];
const publicReadiness = publicFiberReadiness(detailedReadiness);
assert.equal(publicReadiness.readiness, 'ready');
assert.equal('rpcUrl' in publicReadiness, false);
assert.equal('operator' in publicReadiness, false);
assert.equal('peers' in publicReadiness, false);
assert.equal('channels' in publicReadiness, false);
