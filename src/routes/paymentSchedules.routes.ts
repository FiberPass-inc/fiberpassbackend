import { Router } from 'express';
import { z } from 'zod';
import { DESTINATION_KINDS, DESTINATION_RAILS } from '../domain/identity.js';
import { PAYMENT_RAILS } from '../domain/payment.js';
import { SCHEDULE_CADENCES, SCHEDULE_EXECUTORS } from '../domain/schedule.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { ApiError } from '../lib/errors.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  configureReusablePaymentDestination,
  controlPaymentSchedule,
  createPaymentSchedule,
  listPaymentSchedules,
  runDuePaymentSchedules
} from '../services/paymentSchedule.service.js';
import type { AuthenticatedRequest } from '../types/auth.js';

const sessionParamsSchema = z.object({ id: z.string().trim().min(1).max(160) });
const scheduleParamsSchema = z.object({ id: z.string().trim().min(8).max(160) });
const destinationSchema = z.object({
  recipientId: z.string().trim().min(8).max(160),
  rail: z.enum(DESTINATION_RAILS),
  network: z.string().trim().min(1).max(80),
  assetId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._:-]{0,127}$/),
  kind: z.enum(DESTINATION_KINDS),
  value: z.string().trim().min(1).max(10_000),
  resolverEndpoint: z.string().trim().url().max(2000).optional()
});
const scheduleSchema = z.object({
  destinationId: z.string().trim().min(8).max(160),
  rail: z.enum(PAYMENT_RAILS),
  network: z.string().trim().min(1).max(80),
  assetId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._:-]{0,127}$/),
  amountAtomic: z.string().regex(/^[1-9]\d{0,77}$/),
  maxFeeAtomic: z.string().regex(/^(0|[1-9]\d{0,77})$/).optional(),
  executor: z.enum(SCHEDULE_EXECUTORS),
  connectionId: z.string().trim().min(8).max(160).optional(),
  cadence: z.enum(SCHEDULE_CADENCES),
  timeZone: z.string().trim().min(1).max(80),
  firstOccurrenceAt: z.string().datetime(),
  customIntervalSeconds: z.number().int().min(1).max(31_536_000).optional(),
  occurrenceLimit: z.number().int().min(1).max(1_000_000).optional()
});
const controlSchema = z.object({ action: z.enum(['pause', 'resume', 'revoke']) });

export const paymentSchedulesRouter = Router();

function idempotencyKey(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  if (normalized.length < 8 || normalized.length > 160) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header must contain 8 to 160 characters.');
  }
  return normalized;
}

paymentSchedulesRouter.post('/sessions/:id/payment-destinations', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { id } = sessionParamsSchema.parse(request.params);
  const payload = destinationSchema.parse(request.body ?? {});
  response.status(201).json(await configureReusablePaymentDestination({
    sessionId: id,
    ...payload,
    idempotencyKey: idempotencyKey(request.get('Idempotency-Key'))
  }, walletId));
}));

paymentSchedulesRouter.get('/sessions/:id/payment-schedules', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { id } = sessionParamsSchema.parse(request.params);
  response.json(await listPaymentSchedules(id, walletId));
}));

paymentSchedulesRouter.post('/sessions/:id/payment-schedules', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { id } = sessionParamsSchema.parse(request.params);
  const payload = scheduleSchema.parse(request.body ?? {});
  response.status(201).json(await createPaymentSchedule(id, {
    ...payload,
    firstOccurrenceAt: new Date(payload.firstOccurrenceAt),
    idempotencyKey: idempotencyKey(request.get('Idempotency-Key'))
  }, walletId));
}));

paymentSchedulesRouter.post('/payment-schedules/:id/control', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { id } = scheduleParamsSchema.parse(request.params);
  const { action } = controlSchema.parse(request.body ?? {});
  response.json(await controlPaymentSchedule(id, walletId, action));
}));

paymentSchedulesRouter.post('/payment-schedules/sync', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  response.json(await runDuePaymentSchedules({ ownerWalletId: walletId, limit: 25, workerId: 'api-schedule-sync' }));
}));
