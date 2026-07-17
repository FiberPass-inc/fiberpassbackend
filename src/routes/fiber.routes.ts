import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { fiberConnector } from '../connectors/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { ApiError } from '../lib/errors.js';
import { getFiberChannelStrategy, openFiberTestChannel } from '../services/fiberChannel.service.js';
import { runFiberLivePaymentTest } from '../services/fiberLiveTest.service.js';

export const fiberRouter = Router();

const openChannelSchema = z.object({
  peerId: z.string().trim().min(1).max(220).optional(),
  amount: z.coerce.number().positive().max(100000).optional()
});

const livePaymentTestSchema = z.object({
  paymentRequest: z.string().trim().min(16).max(4000),
  amount: z.coerce.number().positive().max(100000).optional()
});

function requireFiberOperator(request: Request, _response: Response, next: NextFunction): void {
  if (!env.CRON_SECRET) {
    next(new ApiError(503, 'OPERATOR_SECRET_NOT_CONFIGURED', 'CRON_SECRET must be configured before running Fiber operator actions.'));
    return;
  }
  if (request.headers.authorization !== 'Bearer ' + env.CRON_SECRET) {
    next(new ApiError(401, 'OPERATOR_UNAUTHORIZED', 'Invalid Fiber operator authorization.'));
    return;
  }
  next();
}

export function publicFiberReadiness(readiness: Awaited<ReturnType<typeof fiberConnector.getReadiness>>) {
  return {
    configured: readiness.configured,
    reachable: readiness.reachable,
    provider: readiness.provider,
    network: readiness.network,
    checkedAt: readiness.checkedAt,
    readiness: readiness.readiness,
    paymentExecution: readiness.paymentExecution
  };
}

fiberRouter.get('/fiber/node/status', requireFiberOperator, asyncHandler(async (_request, response) => {
  response.json(await fiberConnector.getReadiness());
}));

fiberRouter.get('/fiber/node/readiness', asyncHandler(async (_request, response) => {
  response.json(publicFiberReadiness(await fiberConnector.getReadiness()));
}));

fiberRouter.get('/fiber/channels/strategy', requireFiberOperator, asyncHandler(async (_request, response) => {
  response.json(await getFiberChannelStrategy());
}));

fiberRouter.post('/fiber/channels/test-open', requireFiberOperator, asyncHandler(async (request, response) => {
  const payload = openChannelSchema.parse(request.body ?? {});
  response.status(202).json(await openFiberTestChannel(payload));
}));

fiberRouter.post('/fiber/live-e2e', requireFiberOperator, asyncHandler(async (request, response) => {
  const payload = livePaymentTestSchema.parse(request.body ?? {});
  response.status(202).json(await runFiberLivePaymentTest(payload));
}));
