import { Router } from 'express';
import { z } from 'zod';
import { CONTACT_CHANNEL_TYPES } from '../domain/identity.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import {
  createNotificationEndpoint,
  exportReceipts,
  listNotificationEndpoints,
  removeNotificationEndpoint,
  unsubscribeNotificationEndpoint
} from '../services/notification.service.js';
import { listPaymentReceipts } from '../services/receipt.service.js';
import type { AuthenticatedRequest } from '../types/auth.js';

const endpointSchema = z.object({
  recipientId: z.string().trim().min(8).max(120),
  type: z.enum(CONTACT_CHANNEL_TYPES),
  value: z.string().trim().min(3).max(512),
  relayUrls: z.array(z.string().trim().min(6).max(2048)).min(1).max(3).optional()
});
const endpointParamsSchema = z.object({ endpointId: z.string().trim().min(8).max(120) });
const receiptListSchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
const unsubscribeSchema = z.object({ token: z.string().trim().min(40).max(512) });

export const receiptsRouter = Router();

receiptsRouter.get('/receipts', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { limit } = receiptListSchema.parse(request.query);
  response.json({ receipts: await listPaymentReceipts(walletId, limit) });
}));

receiptsRouter.get('/receipts/export', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  response.setHeader('Content-Disposition', 'attachment; filename="fiberpass-receipts.json"');
  response.json(await exportReceipts(walletId));
}));

receiptsRouter.get('/notification-endpoints', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  response.json({ endpoints: await listNotificationEndpoints(walletId) });
}));

receiptsRouter.post('/notification-endpoints', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const input = endpointSchema.parse(request.body ?? {});
  response.status(201).json(await createNotificationEndpoint(input, walletId));
}));

receiptsRouter.post('/notification-endpoints/unsubscribe', asyncHandler(async (request, response) => {
  const { token } = unsubscribeSchema.parse(request.body ?? {});
  response.json(await unsubscribeNotificationEndpoint(token));
}));

receiptsRouter.post('/notification-endpoints/:endpointId/revoke', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { endpointId } = endpointParamsSchema.parse(request.params);
  response.json({ status: 'revoked', cancelledDeliveries: await removeNotificationEndpoint(endpointId, walletId, 'revoked') });
}));

receiptsRouter.delete('/notification-endpoints/:endpointId', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  const { endpointId } = endpointParamsSchema.parse(request.params);
  response.json({ status: 'deleted', cancelledDeliveries: await removeNotificationEndpoint(endpointId, walletId, 'deleted') });
}));
