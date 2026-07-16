import { createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { ApiError } from '../lib/errors.js';
import { RateLimitBucketModel } from '../models/rateLimitBucket.model.js';

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix: string;
  keyGenerator?: (request: Request) => string;
  store?: 'memory' | 'mongo';
}

interface RateLimitResult {
  count: number;
  resetAt: number;
}

const memoryBuckets = new Map<string, RateLimitResult>();

function defaultKey(request: Request): string {
  return request.ip || request.socket.remoteAddress || 'unknown';
}

export function hashRateLimitKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function fixedWindow(input: { now: number; windowMs: number }): { id: number; resetAt: number } {
  const id = Math.floor(input.now / input.windowMs);
  return { id, resetAt: (id + 1) * input.windowMs };
}

function consumeMemory(key: string, resetAt: number): RateLimitResult {
  const existing = memoryBuckets.get(key);
  const result = existing && existing.resetAt === resetAt
    ? { count: existing.count + 1, resetAt }
    : { count: 1, resetAt };
  memoryBuckets.set(key, result);
  if (memoryBuckets.size > 10_000) {
    const now = Date.now();
    for (const [bucketKey, bucket] of memoryBuckets) {
      if (bucket.resetAt <= now) memoryBuckets.delete(bucketKey);
    }
  }
  return result;
}

async function consumeMongo(key: string, resetAt: number, windowMs: number): Promise<RateLimitResult> {
  const expiresAt = new Date(resetAt + windowMs);
  try {
    const bucket = await RateLimitBucketModel.findOneAndUpdate(
      { bucketKey: key },
      {
        $inc: { count: 1 },
        $setOnInsert: { bucketKey: key, expiresAt }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return { count: bucket?.count ?? 1, resetAt };
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (code !== 11000) throw error;
    const bucket = await RateLimitBucketModel.findOneAndUpdate(
      { bucketKey: key },
      { $inc: { count: 1 } },
      { new: true }
    ).lean();
    if (!bucket) throw error;
    return { count: bucket.count, resetAt };
  }
}

export function resetMemoryRateLimits(): void {
  memoryBuckets.clear();
}

export function createRateLimitMiddleware(options: RateLimitOptions) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const now = Date.now();
    const subject = options.keyGenerator?.(request) ?? defaultKey(request);
    const window = fixedWindow({ now, windowMs: options.windowMs });
    const key = options.keyPrefix + ':' + hashRateLimitKey(subject) + ':' + window.id;
    const store = options.store ?? env.RATE_LIMIT_STORE;

    void (store === 'mongo'
      ? consumeMongo(key, window.resetAt, options.windowMs)
      : Promise.resolve(consumeMemory(key, window.resetAt)))
      .then((result) => {
        response.setHeader('RateLimit-Limit', String(options.max));
        response.setHeader('RateLimit-Remaining', String(Math.max(0, options.max - result.count)));
        response.setHeader('RateLimit-Reset', String(Math.ceil(result.resetAt / 1000)));
        if (result.count > options.max) {
          next(new ApiError(429, 'RATE_LIMIT_EXCEEDED', 'Too many requests. Please slow down.'));
          return;
        }
        next();
      })
      .catch(() => {
        next(new ApiError(503, 'RATE_LIMIT_UNAVAILABLE', 'Request safety controls are temporarily unavailable.'));
      });
  };
}
