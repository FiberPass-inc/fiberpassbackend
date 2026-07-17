import { Router } from 'express';
import { PAYMENT_CONTRACT_VERSION } from '../domain/payment.js';
import { paymentConnectorRegistry } from '../connectors/index.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export const paymentConnectorsRouter = Router();

paymentConnectorsRouter.get('/payment-connectors', requireAuth, asyncHandler(async (_request, response) => {
  response.json({
    contractVersion: PAYMENT_CONTRACT_VERSION,
    capabilities: paymentConnectorRegistry.capabilities()
  });
}));
