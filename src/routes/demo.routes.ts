import { Router, type Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { chargeRandomActiveSession, chargeSession } from '../services/session.service.js';

const chargeSchema = z.object({
  sessionId: z.string().min(1),
  amount: z.coerce.number().positive().max(100000),
  type: z.string().trim().min(1).max(120).default('Demo AI/API Action')
});

export const demoRouter = Router();

function sendDemoDisabled(response: Response): void {
  response.status(404).json({
    error: {
      code: 'DEMO_MODE_DISABLED',
      message: 'Demo charge endpoints are disabled outside explicit demo mode.'
    }
  });
}

demoRouter.post('/demo/charge', asyncHandler(async (request, response) => {
  if (!env.DEMO_MODE) {
    sendDemoDisabled(response);
    return;
  }

  const payload = chargeSchema.parse(request.body);
  response.json(await chargeSession(payload));
}));

demoRouter.post('/demo/charge/random', asyncHandler(async (_request, response) => {
  if (!env.DEMO_MODE) {
    sendDemoDisabled(response);
    return;
  }

  const overview = await chargeRandomActiveSession();
  if (!overview) {
    response.status(404).json({
      error: {
        code: 'NO_ACTIVE_SESSIONS',
        message: 'No active auto-charge sessions are available.'
      }
    });
    return;
  }
  response.json(overview);
}));
