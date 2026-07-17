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
  PUBLIC_APP_URL: z.string().url().optional().default('http://localhost:3000'),
  FIBER_NETWORK: z.string().default('testnet'),
  FIBER_PROVIDER: z.literal('rpc').default('rpc'),
  FIBER_RPC_URL: z.string().min(1).default('http://127.0.0.1:8227'),
  FIBER_RPC_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  FIBER_API_KEY: z.string().optional().default(''),
  FIBER_PEER_ID: z.string().optional().default(''),
  FIBER_NODE_MIN_PEERS: z.coerce.number().int().nonnegative().default(1),
  FIBER_NODE_MIN_ACTIVE_CHANNELS: z.coerce.number().int().nonnegative().default(1),
  FIBER_NODE_MIN_OUTBOUND_LIQUIDITY_CKB: z.coerce.number().nonnegative().default(0.01),
  FIBER_TARGET_PEER_IDS: z.string().optional().default(''),
  FIBER_TEST_CHANNEL_AMOUNT_CKB: z.coerce.number().positive().default(0.01),
  FIBER_EXIT_KEYSEND_TARGET_PUBKEY: z.string().optional().default(''),
  FIBER_EXIT_SETTLEMENT_PRIVATE_KEY: z.string().optional().default(''),
  FIBER_NODE_CKB_PRIVATE_KEY: z.string().optional().default(''),
  FIBER_EXIT_SETTLEMENT_LOCK_HASH: z.string().optional().default(''),
  FIBER_EXIT_INVOICE_EXPIRY_SECONDS: z.coerce.number().int().positive().default(86400),
  FIBERPASS_DAILY_SESSION_SPEND_LIMIT_CKB: z.coerce.number().positive().default(100000),
  FIBERPASS_TREASURY_ADDRESS: z.string().optional().default(''),
  FIBERPASS_VAULT_CODE_HASH: z.string().optional().default(''),
  FIBERPASS_VAULT_HASH_TYPE: z.enum(['data', 'type', 'data1', 'data2']).default('type'),
  FIBERPASS_VAULT_CELL_DEP_TX_HASH: z.string().optional().default(''),
  FIBERPASS_VAULT_CELL_DEP_INDEX: z.string().optional().default(''),
  FIBERPASS_VAULT_CELL_DEP_TYPE: z.enum(['code', 'depGroup', 'dep_group']).default('code'),
  FIBERPASS_OPERATOR_LOCK_HASH: z.string().optional().default(''),
  FIBERPASS_OPERATOR_PRIVATE_KEY: z.string().optional().default(''),
  CKB_TESTNET_RPC_URL: z.string().url().default('https://testnet.ckb.dev'),
  CKB_TESTNET_INDEXER_URL: z.string().url().default('https://testnet.ckb.dev'),
  JOYID_SERVER_URL: z.string().url().default('https://api.testnet.joyid.dev/api/v1'),
  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanFromEnv.default(false),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASS: z.string().optional().default(''),
  EMAIL_FROM_ADDRESS: z.string().email().default('xbeach329@gmail.com'),
  EMAIL_FROM_NAME: z.string().default('FiberPass'),
  EMAIL_DEFAULT_TIME_ZONE: z.string().optional().default('Africa/Nairobi'),
  NOTIFICATION_TOKEN_SECRET: z.string().optional().default(''),
  NOSTR_NOTIFICATION_SECRET_KEY: z.string().optional().default(''),
  NOSTR_NOTIFICATION_ALLOW_INSECURE_LOCAL_RELAY: booleanFromEnv.default(false),
  NOTIFICATION_DELIVERY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  NOTIFICATION_DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  RECIPIENT_MAGIC_LINK_TTL_HOURS: z.coerce.number().int().positive().default(72),
  REQUEST_BODY_LIMIT: z.string().default('128kb'),
  TRUST_PROXY: booleanFromEnv.default(false),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_GLOBAL_MAX: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(20),
  RATE_LIMIT_APP_CHARGE_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_STORE: z.enum(['memory', 'mongo']).default('mongo'),
  STREAM_TICKET_TTL_SECONDS: z.coerce.number().int().min(30).max(300).default(60),
  PAYMENT_WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  PAYMENT_WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  RECONCILIATION_WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(15000),
  RECONCILIATION_WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(25),
  WEBHOOK_WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  WEBHOOK_WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  WORKER_HEARTBEAT_STALE_MS: z.coerce.number().int().positive().default(30000),
  WORKER_LEASE_TTL_MS: z.coerce.number().int().positive().default(60000),
  WEBHOOK_DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  WEBHOOK_SECRET_ENCRYPTION_KEY: z.string().optional().default(''),
  NWC_SECRET_ENCRYPTION_KEY: z.string().optional().default(''),
  NWC_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  NWC_ALLOW_INSECURE_LOCAL_RELAY: booleanFromEnv.default(false),
  BTCPAY_SECRET_ENCRYPTION_KEY: z.string().optional().default(''),
  BTCPAY_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  BTCPAY_ALLOW_INSECURE_LOCAL: booleanFromEnv.default(false),
  SCHEDULE_RESOLVER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(10000),
  SCHEDULE_ALLOW_INSECURE_LOCAL_RESOLVERS: booleanFromEnv.default(false),
  BITCOIN_NETWORK: z.enum(['mainnet', 'testnet', 'signet', 'regtest']).default('regtest'),
  BITCOIN_CORE_RPC_URL: z.string().optional().default(''),
  BITCOIN_CORE_RPC_USER: z.string().optional().default(''),
  BITCOIN_CORE_RPC_PASSWORD: z.string().optional().default(''),
  BITCOIN_CORE_RPC_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  CRON_SECRET: z.string().optional().default(""),
  AUTOMATION_MAX_INVOICE_CKB: z.coerce.number().positive().default(1000),
  AUTOMATION_MAX_BATCH_CKB: z.coerce.number().positive().default(5000),
  AUTOMATION_DAILY_LIMIT_CKB: z.coerce.number().positive().default(10000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info')
}).superRefine((env, ctx) => {
  if (env.NODE_ENV === 'production' && env.FRONTEND_ORIGIN === '*') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['FRONTEND_ORIGIN'],
      message: 'FRONTEND_ORIGIN must be an explicit allowlist in production.'
    });
  }

  if (env.NODE_ENV === 'production') {
    const localHosts = new Set(['127.0.0.1', 'localhost', '0.0.0.0']);
    const isLocalUrl = (value: string): boolean => {
      try {
        return localHosts.has(new URL(value).hostname);
      } catch {
        return false;
      }
    };

    if (isLocalUrl(env.FIBER_RPC_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FIBER_RPC_URL'],
        message: 'FIBER_RPC_URL must point to a reachable HTTPS Fiber RPC gateway in production.'
      });
    }

    if (isLocalUrl(env.PUBLIC_APP_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['PUBLIC_APP_URL'],
        message: 'PUBLIC_APP_URL must be the deployed frontend URL in production.'
      });
    }

    if (!env.CRON_SECRET.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CRON_SECRET'],
        message: 'CRON_SECRET is required in production for worker and operator endpoints.'
      });
    }

    if (env.NOTIFICATION_TOKEN_SECRET.trim().length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NOTIFICATION_TOKEN_SECRET'],
        message: 'NOTIFICATION_TOKEN_SECRET must contain at least 32 random characters in production.'
      });
    }
    if (env.NOSTR_NOTIFICATION_SECRET_KEY && !/^[a-f0-9]{64}$/i.test(env.NOSTR_NOTIFICATION_SECRET_KEY.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NOSTR_NOTIFICATION_SECRET_KEY'],
        message: 'NOSTR_NOTIFICATION_SECRET_KEY must be a 32-byte hex Nostr sender key.'
      });
    }
    if (env.NOSTR_NOTIFICATION_ALLOW_INSECURE_LOCAL_RELAY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NOSTR_NOTIFICATION_ALLOW_INSECURE_LOCAL_RELAY'],
        message: 'Insecure local Nostr notification relays cannot be enabled in production.'
      });
    }

    const nwcKey = /^[a-f0-9]{64}$/i.test(env.NWC_SECRET_ENCRYPTION_KEY.trim())
      ? Buffer.from(env.NWC_SECRET_ENCRYPTION_KEY.trim(), 'hex')
      : Buffer.from(env.NWC_SECRET_ENCRYPTION_KEY.trim(), 'base64');
    if (nwcKey.length !== 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NWC_SECRET_ENCRYPTION_KEY'],
        message: 'NWC_SECRET_ENCRYPTION_KEY must contain 32 random bytes encoded as hex or base64 in production.'
      });
    }

    if (env.NWC_ALLOW_INSECURE_LOCAL_RELAY) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['NWC_ALLOW_INSECURE_LOCAL_RELAY'],
        message: 'Insecure local NWC relays cannot be enabled in production.'
      });
    }

    const btcpayKey = /^[a-f0-9]{64}$/i.test(env.BTCPAY_SECRET_ENCRYPTION_KEY.trim())
      ? Buffer.from(env.BTCPAY_SECRET_ENCRYPTION_KEY.trim(), 'hex')
      : Buffer.from(env.BTCPAY_SECRET_ENCRYPTION_KEY.trim(), 'base64');
    if (btcpayKey.length !== 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BTCPAY_SECRET_ENCRYPTION_KEY'],
        message: 'BTCPAY_SECRET_ENCRYPTION_KEY must contain 32 random bytes encoded as hex or base64 in production.'
      });
    }
    if (env.BTCPAY_ALLOW_INSECURE_LOCAL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BTCPAY_ALLOW_INSECURE_LOCAL'],
        message: 'Insecure local BTCPay connections cannot be enabled in production.'
      });
    }
    if (env.SCHEDULE_ALLOW_INSECURE_LOCAL_RESOLVERS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCHEDULE_ALLOW_INSECURE_LOCAL_RESOLVERS'],
        message: 'Insecure local scheduled-payment resolvers cannot be enabled in production.'
      });
    }
  }
});

export const env = envSchema.parse(process.env);
export const isProduction = env.NODE_ENV === 'production';
