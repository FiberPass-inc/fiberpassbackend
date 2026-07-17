import { Router } from 'express';
import { z } from 'zod';
import { NWC_EXECUTION_MODES, NWC_NETWORKS, NWC_SCOPE_TYPES } from '../domain/nwc.js';
import { ApiError } from '../lib/errors.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  disconnectNwcConnection,
  getNwcPaymentStatus,
  listNwcConnections,
  pairNwcConnection,
  payNwcInvoice,
  syncNwcBalance
} from '../services/nwc.service.js';
import type { AuthenticatedRequest } from '../types/auth.js';

const connectionParamsSchema = z.object({ connectionId: z.string().trim().min(8).max(80) });
const paymentParamsSchema = connectionParamsSchema.extend({ paymentHash: z.string().trim().regex(/^[0-9a-fA-F]{64}$/) });
const pairSchema = z.object({
  connectionUri: z.string().trim().min(32).max(4096),
  network: z.enum(NWC_NETWORKS),
  scopeType: z.enum(NWC_SCOPE_TYPES).default('wallet'),
  scopeId: z.string().trim().min(1).max(120).optional(),
  executionMode: z.enum(NWC_EXECUTION_MODES).default('interactive')
});
const paymentSchema = z.object({
  invoice: z.string().trim().min(20).max(8192),
  idempotencyKey: z.string().trim().min(8).max(160).optional()
});
const disconnectSchema = z.object({ reason: z.string().trim().min(1).max(160).optional() });

export const nwcRouter = Router();

nwcRouter.get('/wallet/nwc-connections', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  response.json(await listNwcConnections(walletId));
}));

nwcRouter.post('/wallet/nwc-connections', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const input = pairSchema.parse(request.body ?? {});
  response.status(201).json(await pairNwcConnection(input, walletId));
}));

nwcRouter.post('/wallet/nwc-connections/:connectionId/balance/sync', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { connectionId } = connectionParamsSchema.parse(request.params);
  response.json(await syncNwcBalance(connectionId, walletId));
}));

nwcRouter.post('/wallet/nwc-connections/:connectionId/payments', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { connectionId } = connectionParamsSchema.parse(request.params);
  const input = paymentSchema.parse(request.body ?? {});
  const idempotencyKey = input.idempotencyKey ?? request.header('idempotency-key')?.trim();
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 160) {
    throw new ApiError(400, 'NWC_IDEMPOTENCY_KEY_REQUIRED', 'NWC payments require an idempotency key between 8 and 160 characters.');
  }
  const payment = await payNwcInvoice({
    connectionId,
    ownerWalletId: walletId,
    invoice: input.invoice,
    idempotencyKey
  });
  response.status(payment.status === 'pending' || payment.status === 'uncertain' ? 202 : 200).json(payment);
}));

nwcRouter.get('/wallet/nwc-connections/:connectionId/payments/:paymentHash', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { connectionId, paymentHash } = paymentParamsSchema.parse(request.params);
  const payment = await getNwcPaymentStatus({ connectionId, ownerWalletId: walletId, paymentHash });
  response.status(payment.status === 'uncertain' || payment.status === 'pending' ? 202 : 200).json(payment);
}));

nwcRouter.delete('/wallet/nwc-connections/:connectionId', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { connectionId } = connectionParamsSchema.parse(request.params);
  const { reason } = disconnectSchema.parse(request.body ?? {});
  await disconnectNwcConnection(connectionId, walletId, reason);
  response.status(204).end();
}));
