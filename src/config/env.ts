import 'dotenv/config';
import { z } from 'zod';

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== 'string') return value;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;

  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  MONGODB_URI: z.string().min(1).default('mongodb://127.0.0.1:27017/fiberpass'),
  FRONTEND_ORIGIN: z.string().default('http://localhost:3000'),
  DEMO_MODE: booleanFromEnv.default(false),
  DEMO_AUTO_CHARGE: booleanFromEnv.default(false),
  DEMO_CHARGE_INTERVAL_MS: z.coerce.number().int().positive().default(4500),
  FIBER_NETWORK: z.string().default('testnet'),
  FIBER_PROVIDER: z.enum(['mock', 'rpc']).default('mock'),
  FIBER_RPC_URL: z.string().optional().default(''),
  FIBER_API_KEY: z.string().optional().default(''),
  FIBER_PEER_ID: z.string().optional().default(''),
  REQUEST_BODY_LIMIT: z.string().default('128kb'),
  TRUST_PROXY: booleanFromEnv.default(false),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_APP_CHARGE_MAX: z.coerce.number().int().positive().default(120),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.DEMO_MODE) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DEMO_MODE'],
      message: 'DEMO_MODE must be false in production.'
    });
  }

  if (env.NODE_ENV === 'production' && env.FRONTEND_ORIGIN === '*') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['FRONTEND_ORIGIN'],
      message: 'FRONTEND_ORIGIN must be an explicit allowlist in production.'
    });
  }

  if (env.FIBER_PROVIDER === 'rpc' && !env.FIBER_RPC_URL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['FIBER_RPC_URL'],
      message: 'FIBER_RPC_URL is required when FIBER_PROVIDER=rpc.'
    });
  }
});

export const env = envSchema.parse(process.env);
export const isProduction = env.NODE_ENV === 'production';
