import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { logger } from '../lib/logger.js';

export interface RequestWithContext extends Request {
  requestId: string;
}

export function requestContext(request: Request, response: Response, next: NextFunction): void {
  const requestId = request.header('x-request-id') || randomUUID();
  (request as RequestWithContext).requestId = requestId;
  response.setHeader('x-request-id', requestId);

  const startedAt = Date.now();
  response.on('finish', () => {
    logger.info('http_request', {
      requestId,
      method: request.method,
      path: request.path,
      statusCode: response.statusCode,
      durationMs: Date.now() - startedAt
    });
  });

  next();
}

export function getRequestId(request: Request): string | undefined {
  return (request as Partial<RequestWithContext>).requestId;
}
