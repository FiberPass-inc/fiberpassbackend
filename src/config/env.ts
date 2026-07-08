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
  FIBER_RPC_URL: z.string().optional().default(''),
  FIBER_API_KEY: z.string().optional().default('')
});

export const env = envSchema.parse(process.env);
