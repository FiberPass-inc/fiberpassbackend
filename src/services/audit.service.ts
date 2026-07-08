import { AuditLogModel } from '../models/auditLog.model.js';
import { logger } from '../lib/logger.js';

export interface AuditLogInput {
  actorWalletId?: string;
  actorAddress?: string;
  action: string;
  targetType: string;
  targetId?: string;
  requestId?: string;
  ip?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
}

export async function writeAuditLog(input: AuditLogInput): Promise<void> {
  try {
    await AuditLogModel.create(input);
  } catch (error) {
    logger.warn('audit_log_write_failed', { action: input.action, targetType: input.targetType, error });
  }
}
