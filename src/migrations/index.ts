import { createHash } from 'node:crypto';
import { Types } from 'mongoose';
import { AppApiKeyModel, AppModel } from '../models/app.model.js';
import { AuditLogModel } from '../models/auditLog.model.js';
import { AuthChallengeModel, AuthSessionModel } from '../models/auth.model.js';
import { InvoiceModel, PaymentBatchModel, PaymentJobModel, RecipientModel } from '../models/automation.model.js';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import { ChargeDailyCounterModel } from '../models/chargeDailyCounter.model.js';
import { DomainEventModel } from '../models/domainEvent.model.js';
import { MigrationModel } from '../models/migration.model.js';
import { RateLimitBucketModel } from '../models/rateLimitBucket.model.js';
import { SessionModel } from '../models/session.model.js';
import { StreamTicketModel } from '../models/streamTicket.model.js';
import { WalletModel } from '../models/wallet.model.js';
import { WalletFundingModel } from '../models/walletFunding.model.js';
import { WebhookDeliveryModel } from '../models/webhookDelivery.model.js';
import { WorkerHeartbeatModel } from '../models/workerHeartbeat.model.js';
import { WorkerLeaseModel } from '../models/workerLease.model.js';
import { encryptWebhookSecret } from '../services/webhookSecurity.service.js';

export interface MigrationDefinition {
  id: string;
  description: string;
  up(): Promise<void>;
}

const indexedModels = [
  AppModel,
  AppApiKeyModel,
  AuditLogModel,
  AuthChallengeModel,
  AuthSessionModel,
  RecipientModel,
  InvoiceModel,
  PaymentJobModel,
  PaymentBatchModel,
  ChargeAttemptModel,
  ChargeDailyCounterModel,
  DomainEventModel,
  MigrationModel,
  RateLimitBucketModel,
  SessionModel,
  StreamTicketModel,
  WalletModel,
  WalletFundingModel,
  WebhookDeliveryModel,
  WorkerHeartbeatModel,
  WorkerLeaseModel
];

async function dropIndexIfPresent(collection: { dropIndex(name: string): Promise<unknown> }, indexName: string): Promise<void> {
  try {
    await collection.dropIndex(indexName);
  } catch (error) {
    const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
    if (code !== 26 && code !== 27) throw error;
  }
}

const createProductionIndexes: MigrationDefinition = {
  id: '001-create-production-indexes',
  description: 'Create all declared production indexes without runtime autoIndex.',
  async up() {
    await dropIndexIfPresent(AuthChallengeModel.collection, 'expiresAt_1');
    await dropIndexIfPresent(AuthSessionModel.collection, 'expiresAt_1');
    await dropIndexIfPresent(RateLimitBucketModel.collection, 'expiresAt_1');
    await dropIndexIfPresent(StreamTicketModel.collection, 'expiresAt_1');
    for (const model of indexedModels) await model.createIndexes();
  }
};

const encryptLegacyWebhookSecrets: MigrationDefinition = {
  id: '002-encrypt-legacy-webhook-secrets',
  description: 'Move legacy app webhook secrets to encrypted app storage and remove delivery copies.',
  async up() {
    const legacyApps = await AppModel.collection.find<{ _id: Types.ObjectId; webhookSigningSecret: string }>({
      webhookSigningSecret: { $type: 'string', $ne: '' }
    }).toArray();
    for (const app of legacyApps) {
      const encrypted = encryptWebhookSecret(app.webhookSigningSecret);
      const hash = createHash('sha256').update(app.webhookSigningSecret).digest('hex');
      await AppModel.collection.updateOne(
        { _id: app._id },
        {
          $set: { webhookSigningSecretEncrypted: encrypted, webhookSecretHash: hash },
          $unset: { webhookSigningSecret: '' }
        }
      );
    }
    await WebhookDeliveryModel.collection.updateMany(
      { signingSecret: { $exists: true } },
      { $unset: { signingSecret: '' } }
    );
  }
};

const createSecurityControlIndexes: MigrationDefinition = {
  id: '003-create-security-control-indexes',
  description: 'Create shared rate-limit and short-lived stream-ticket indexes.',
  async up() {
    await dropIndexIfPresent(RateLimitBucketModel.collection, 'expiresAt_1');
    await dropIndexIfPresent(StreamTicketModel.collection, 'expiresAt_1');
    await RateLimitBucketModel.createIndexes();
    await StreamTicketModel.createIndexes();
  }
};

export const migrations: readonly MigrationDefinition[] = [
  createProductionIndexes,
  encryptLegacyWebhookSecrets,
  createSecurityControlIndexes
];
