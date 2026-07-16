import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors.js';
import { getAuthContextFromStreamTicket, getAuthContextFromToken } from '../services/auth.service.js';
import type { AuthenticatedRequest } from '../types/auth.js';

export function readBearerToken(request: Request): string | null {
  const header = request.header('authorization');
  if (header?.startsWith('Bearer ')) {
    return header.slice('Bearer '.length).trim();
  }
  return null;
}

export async function requireAuth(request: Request, _response: Response, next: NextFunction): Promise<void> {
  try {
    const token = readBearerToken(request);
    if (!token) {
      throw new ApiError(401, 'AUTH_REQUIRED', 'Connect with JoyID before using FiberPass.');
    }

    (request as AuthenticatedRequest).auth = await getAuthContextFromToken(token);
    next();
  } catch (error) {
    next(error);
  }
}

export async function requireStreamTicket(request: Request, _response: Response, next: NextFunction): Promise<void> {
  try {
    const ticket = typeof request.query.ticket === 'string' ? request.query.ticket.trim() : '';
    if (!ticket) {
      throw new ApiError(401, 'STREAM_TICKET_REQUIRED', 'Create a short-lived live-update ticket before opening the event stream.');
    }
    (request as AuthenticatedRequest).auth = await getAuthContextFromStreamTicket(ticket);
    next();
  } catch (error) {
    next(error);
  }
}
