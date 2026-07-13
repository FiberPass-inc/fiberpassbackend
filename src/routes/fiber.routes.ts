import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getFiberNodeReadiness } from '../services/fiberNode.service.js';

export const fiberRouter = Router();

fiberRouter.get('/fiber/node/status', asyncHandler(async (_request, response) => {
  response.json(await getFiberNodeReadiness());
}));
