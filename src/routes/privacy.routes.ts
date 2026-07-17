import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { deleteContactData, exportContactData } from '../services/recipientIdentity.service.js';
import type { AuthenticatedRequest } from '../types/auth.js';

export const privacyRouter = Router();

privacyRouter.get('/privacy/export', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  response.json(await exportContactData(walletId));
}));

privacyRouter.delete('/privacy/contact-data', requireAuth, asyncHandler(async (request, response) => {
  const { walletId } = (request as AuthenticatedRequest).auth;
  response.json(await deleteContactData(walletId));
}));
