import { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { liveEvents } from '../lib/liveEvents.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  createSession,
  getSessionsOverview,
  isValidIconType,
  resetDemoData,
  revokeSession,
  settleSession,
  togglePauseSession,
  topUpSession
} from '../services/session.service.js';
import type { AuthenticatedRequest } from '../types/auth.js';

const createSessionSchema = z.object({
  name: z.string().trim().min(1).max(80),
  serviceAddress: z.string().trim().min(3).max(120),
  limit: z.coerce.number().positive().max(100000),
  currency: z.string().trim().min(2).max(12).default('USDC'),
  duration: z.string().trim().min(1).max(40),
  expiryTime: z.string().trim().min(1).max(80),
  autoMicroCharges: z.coerce.boolean().default(true),
  singleUse: z.coerce.boolean().default(false),
  iconType: z.string().refine(isValidIconType, 'Invalid icon type')
});

const topUpSchema = z.object({
  amount: z.coerce.number().positive().max(100000).default(1)
});

const paramsSchema = z.object({ id: z.string().min(1) });

export const sessionsRouter = Router();

sessionsRouter.get('/sessions', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  response.json(await getSessionsOverview(walletId));
}));

sessionsRouter.post('/sessions', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const payload = createSessionSchema.parse(request.body);
  response.status(201).json(await createSession(payload, walletId));
}));

sessionsRouter.post('/sessions/:id/top-up', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { id } = paramsSchema.parse(request.params);
  const { amount } = topUpSchema.parse(request.body ?? {});
  response.json(await topUpSession(id, walletId, amount));
}));

sessionsRouter.post('/sessions/:id/toggle-pause', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { id } = paramsSchema.parse(request.params);
  response.json(await togglePauseSession(id, walletId));
}));

sessionsRouter.post('/sessions/:id/revoke', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { id } = paramsSchema.parse(request.params);
  response.json(await revokeSession(id, walletId));
}));

sessionsRouter.post('/sessions/:id/settle', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { id } = paramsSchema.parse(request.params);
  response.json(await settleSession(id, walletId));
}));

sessionsRouter.post('/demo/reset', asyncHandler(async (_request, response) => {
  if (!env.DEMO_MODE) {
    response.status(404).json({
      error: {
        code: 'DEMO_MODE_DISABLED',
        message: 'Demo reset is disabled outside explicit demo mode.'
      }
    });
    return;
  }

  response.json(await resetDemoData());
}));

sessionsRouter.get('/events', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;

  response.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const send = (eventName: string, payload: unknown) => {
    response.write(`event: ${eventName}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const eventName = `overview:${walletId}`;
  const overviewHandler = (payload: unknown) => send('overview', payload);
  liveEvents.on(eventName, overviewHandler);

  send('overview', await getSessionsOverview(walletId));
  const heartbeat = setInterval(() => send('heartbeat', { at: new Date().toISOString() }), 30000);

  request.on('close', () => {
    clearInterval(heartbeat);
    liveEvents.off(eventName, overviewHandler);
    response.end();
  });
}));
