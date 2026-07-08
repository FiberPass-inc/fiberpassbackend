import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../lib/errors.js';

interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix: string;
  keyGenerator?: (request: Request) => string;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function defaultKey(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

export function hashRateLimitKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function createRateLimitMiddleware(options: RateLimitOptions) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const now = Date.now();
    const subject = options.keyGenerator?.(request) ?? defaultKey(request);
    const key = options.keyPrefix + ':' + subject;
    const existing = buckets.get(key);
    const bucket = existing && existing.resetAt > now ? existing : { count: 0, resetAt: now + options.windowMs };
    bucket.count += 1;
    buckets.set(key, bucket);

    response.setHeader('RateLimit-Limit', String(options.max));
    response.setHeader('RateLimit-Remaining', String(Math.max(0, options.max - bucket.count)));
    response.setHeader('RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > options.max) {
      next(new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests. Please slow down.'));
      return;
    }

    if (buckets.size > 10000) {
      for (const [bucketKey, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(bucketKey);
      }
    }

    next();
  };
}
