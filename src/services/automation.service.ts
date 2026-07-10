import { createHash, randomUUID } from 'node:crypto';
import { AUTOMATION_AUDIT_ACTIONS } from '../domain/automation.js';
import { ApiError } from '../lib/errors.js';
import { fallbackMinorUnits, fromMinorUnits, toMinorUnits } from '../lib/money.js';
import { FIBER_CKB_ADDRESS_ERROR, isFiberCkbAddress } from '../lib/fiberAddress.js';
import { AppModel, type AppRecord } from '../models/app.model.js';
import { InvoiceModel, PaymentBatchModel, RecipientModel, type InvoiceRecord, type PaymentBatchRecord, type RecipientRecord } from '../models/automation.model.js';
import { SessionModel, type SessionRecord } from '../models/session.model.js';
import { writeAuditLog } from './audit.service.js';

export interface AutomationActor {
  appId: string;
  ownerWalletId: string;
  source: 'wallet' | 'app_api_key';
  keyId?: string;
}

export interface CreateRecipientInput {
  name: string;
  serviceAddress: string;
  externalId?: string;
  invoiceEndpoint?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdateRecipientInput {
  name?: string;
  serviceAddress?: string;
  externalId?: string;
  invoiceEndpoint?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateInvoiceInput {
  sessionId: string;
  recipientId: string;
  amount: number;
  type?: string;
  description?: string;
  memo?: string;
  externalReference?: string;
  idempotencyKey?: string;
  fiberInvoice?: string;
  dueAt?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateInvoiceBatchInput {
  sessionId: string;
  description?: string;
  externalReference?: string;
  idempotencyKey?: string;
  metadata?: Record<string, unknown>;
  invoices: Array<Omit<CreateInvoiceInput, 'sessionId'>>;
}

export interface RecipientDto {
  id: string;
  appId: string;
  name: string;
  serviceAddress: string;
  addressType: string;
  externalId?: string;
  invoiceEndpoint?: string;
  status: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  disabledAt?: string;
}

export interface InvoiceDto {
  id: string;
  appId: string;
  sessionId: string;
  recipientId: string;
  batchId?: string;
  amount: number;
  amountMinor: number;
  currency: string;
  status: string;
  type: string;
  description: string;
  memo: string;
  externalReference?: string;
  idempotencyKey?: string;
  fiberInvoiceHash?: string;
  hasFiberInvoice: boolean;
  chargeAttemptId?: string;
  paymentJobId?: string;
  dueAt?: string;
  queuedAt?: string;
  processingAt?: string;
  paidAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  lastFailureCode?: string;
  lastFailureMessage?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentBatchDto {
  id: string;
  appId: string;
  sessionId: string;
  status: string;
  description: string;
  externalReference?: string;
  idempotencyKey?: string;
  totalAmount: number;
  totalAmountMinor: number;
  currency: string;
  invoiceCount: number;
  paidCount: number;
  failedCount: number;
  createdAt: string;
  updatedAt: string;
  invoices: InvoiceDto[];
}


function newRecipientId(): string {
  return 'fp_rec_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

function newInvoiceId(): string {
  return 'fp_inv_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

function newBatchId(): string {
  return 'fp_batch_' + randomUUID().replace(/-/g, '').slice(0, 16);
}

export function normalizeFiberInvoice(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function hashFiberInvoice(value: string): string {
  return createHash('sha256').update(value.trim()).digest('hex');
}


function cleanOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function toMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function toRecipientDto(record: RecipientRecord & { createdAt?: Date; updatedAt?: Date; disabledAt?: Date | null }): RecipientDto {
  return {
    id: record.recipientId,
    appId: record.appId,
    name: record.name,
    serviceAddress: record.serviceAddress,
    addressType: record.addressType,
    externalId: record.externalId ?? undefined,
    invoiceEndpoint: record.invoiceEndpoint ?? undefined,
    status: record.status,
    metadata: toMetadata(record.metadata),
    createdAt: (record.createdAt ?? new Date()).toISOString(),
    updatedAt: (record.updatedAt ?? record.createdAt ?? new Date()).toISOString(),
    disabledAt: record.disabledAt?.toISOString()
  };
}

function toInvoiceDto(record: InvoiceRecord & { createdAt?: Date; updatedAt?: Date }): InvoiceDto {
  return {
    id: record.invoiceId,
    appId: record.appId,
    sessionId: record.sessionId,
    recipientId: record.recipientId,
    batchId: record.batchId ?? undefined,
    amount: fromMinorUnits(record.amountMinor, record.currency),
    amountMinor: record.amountMinor,
    currency: record.currency,
    status: record.status,
    type: record.type ?? 'Invoice payment',
    description: record.description ?? '',
    memo: record.memo ?? '',
    externalReference: record.externalReference ?? undefined,
    idempotencyKey: record.idempotencyKey ?? undefined,
    fiberInvoiceHash: record.fiberInvoiceHash ?? undefined,
    hasFiberInvoice: Boolean(record.fiberInvoice),
    chargeAttemptId: record.chargeAttemptId ?? undefined,
    paymentJobId: record.paymentJobId ?? undefined,
    dueAt: record.dueAt?.toISOString(),
    queuedAt: record.queuedAt?.toISOString(),
    processingAt: record.processingAt?.toISOString(),
    paidAt: record.paidAt?.toISOString(),
    failedAt: record.failedAt?.toISOString(),
    cancelledAt: record.cancelledAt?.toISOString(),
    lastFailureCode: record.lastFailureCode ?? undefined,
    lastFailureMessage: record.lastFailureMessage ?? undefined,
    metadata: toMetadata(record.metadata),
    createdAt: (record.createdAt ?? new Date()).toISOString(),
    updatedAt: (record.updatedAt ?? record.createdAt ?? new Date()).toISOString()
  };
}

function toPaymentBatchDto(
  record: PaymentBatchRecord & { createdAt?: Date; updatedAt?: Date },
  invoices: InvoiceDto[] = []
): PaymentBatchDto {
  return {
    id: record.batchId,
    appId: record.appId,
    sessionId: record.sessionId,
    status: record.status,
    description: record.description ?? '',
    externalReference: record.externalReference ?? undefined,
    idempotencyKey: record.idempotencyKey ?? undefined,
    totalAmount: fromMinorUnits(record.totalAmountMinor, record.currency),
    totalAmountMinor: record.totalAmountMinor,
    currency: record.currency,
    invoiceCount: record.invoiceCount,
    paidCount: record.paidCount,
    failedCount: record.failedCount,
    createdAt: (record.createdAt ?? new Date()).toISOString(),
    updatedAt: (record.updatedAt ?? record.createdAt ?? new Date()).toISOString(),
    invoices
  };
}

function normalizeOptionalDate(value?: string): Date | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, 'INVALID_INVOICE_DUE_DATE', 'Invoice due date must be a valid ISO date.');
  }
  return date;
}

function sessionSpentMinor(session: { spent?: number | null; spentMinor?: number | null; currency?: string | null }): number {
  return fallbackMinorUnits(session.spentMinor, session.spent, session.currency ?? 'CKB');
}

function sessionLimitMinor(session: { limit?: number | null; limitMinor?: number | null; currency?: string | null }): number {
  return fallbackMinorUnits(session.limitMinor, session.limit, session.currency ?? 'CKB');
}

function normalizedAddress(value?: string): string {
  return (value ?? '').trim().toLowerCase();
}


function auditMetadata(actor: AutomationActor, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    appId: actor.appId,
    source: actor.source,
    keyId: actor.keyId,
    ...extra
  };
}

async function ensureActorApp(actor: AutomationActor): Promise<AppRecord> {
  const app = await AppModel.findOne({ appId: actor.appId, ownerWalletId: actor.ownerWalletId }).lean<AppRecord>();
  if (!app) {
    throw new ApiError(404, 'APP_NOT_FOUND', 'Developer app was not found for this wallet.');
  }
  return app;
}

function validateRecipientAddress(serviceAddress: string): void {
  if (!isFiberCkbAddress(serviceAddress)) {
    throw new ApiError(400, 'INVALID_RECIPIENT_ADDRESS', FIBER_CKB_ADDRESS_ERROR);
  }
}


async function getRecipientForInvoice(actor: AutomationActor, recipientId: string): Promise<RecipientRecord> {
  const recipient = await RecipientModel.findOne({
    recipientId,
    appId: actor.appId,
    ownerWalletId: actor.ownerWalletId,
    status: 'active'
  }).lean<RecipientRecord>();

  if (!recipient) {
    throw new ApiError(404, 'RECIPIENT_NOT_FOUND', 'Active recipient was not found for this app.');
  }
  return recipient;
}

async function getAutomationSession(actor: AutomationActor, sessionId: string, app: AppRecord): Promise<SessionRecord> {
  const session = await SessionModel.findOne({ publicId: sessionId, ownerWalletId: actor.ownerWalletId }).lean<SessionRecord>();
  if (!session) {
    throw new ApiError(404, 'SESSION_NOT_FOUND', 'FiberPass session was not found for this app owner.');
  }

  const appIdMatches = session.appId === actor.appId;
  const serviceAddressMatches = normalizedAddress(session.serviceAddress) === normalizedAddress(app.serviceAddress);
  if (!appIdMatches && !serviceAddressMatches) {
    throw new ApiError(403, 'APP_SESSION_MISMATCH', 'Invoice session is not authorized for this app.');
  }

  if (session.status !== 'active') {
    throw new ApiError(409, 'SESSION_NOT_CHARGEABLE', 'Invoices can only be created for active FiberPass sessions.');
  }

  const expiryAt = session.expiryAt instanceof Date ? session.expiryAt : undefined;
  if (expiryAt && expiryAt.getTime() <= Date.now()) {
    throw new ApiError(410, 'SESSION_EXPIRED', 'Invoices cannot be created for an expired FiberPass session.');
  }

  return session;
}

async function openInvoiceExposureMinor(actor: AutomationActor, sessionId: string): Promise<number> {
  const openInvoices = await InvoiceModel.find({
    appId: actor.appId,
    ownerWalletId: actor.ownerWalletId,
    sessionId,
    status: { $in: ['draft', 'queued', 'processing', 'failed'] }
  }).select('amountMinor').lean<Array<{ amountMinor?: number }>>();

  return openInvoices.reduce((total, invoice) => total + (invoice.amountMinor ?? 0), 0);
}

async function validateInvoiceCapacity(input: {
  actor: AutomationActor;
  session: SessionRecord;
  sessionId: string;
  newAmountMinor: number;
}): Promise<void> {
  const limitMinor = sessionLimitMinor(input.session);
  const spentMinor = sessionSpentMinor(input.session);
  const remainingMinor = Math.max(0, limitMinor - spentMinor);
  const openExposureMinor = await openInvoiceExposureMinor(input.actor, input.sessionId);

  if (openExposureMinor + input.newAmountMinor > remainingMinor) {
    throw new ApiError(402, 'SESSION_LIMIT_EXCEEDED', 'Invoice amount exceeds remaining FiberPass automation capacity.');
  }
}

function buildInvoiceRecord(input: {
  actor: AutomationActor;
  sessionId: string;
  batchId?: string;
  invoice: CreateInvoiceInput | Omit<CreateInvoiceInput, 'sessionId'>;
  amountMinor: number;
  currency: string;
}): Record<string, unknown> {
  const fiberInvoice = normalizeFiberInvoice(input.invoice.fiberInvoice);
  return {
    invoiceId: newInvoiceId(),
    ownerWalletId: input.actor.ownerWalletId,
    appId: input.actor.appId,
    sessionId: input.sessionId,
    recipientId: input.invoice.recipientId,
    batchId: input.batchId,
    amount: fromMinorUnits(input.amountMinor, input.currency),
    amountMinor: input.amountMinor,
    currency: input.currency,
    status: 'draft',
    type: cleanOptionalString(input.invoice.type) ?? 'Invoice payment',
    description: cleanOptionalString(input.invoice.description) ?? '',
    memo: cleanOptionalString(input.invoice.memo) ?? '',
    externalReference: cleanOptionalString(input.invoice.externalReference),
    idempotencyKey: cleanOptionalString(input.invoice.idempotencyKey),
    fiberInvoice,
    fiberInvoiceHash: fiberInvoice ? hashFiberInvoice(fiberInvoice) : undefined,
    dueAt: normalizeOptionalDate(input.invoice.dueAt),
    metadata: input.invoice.metadata
  };
}

export async function listRecipients(actor: AutomationActor): Promise<{ recipients: RecipientDto[] }> {
  await ensureActorApp(actor);
  const recipients = await RecipientModel.find({ appId: actor.appId, ownerWalletId: actor.ownerWalletId })
    .sort({ createdAt: -1 })
    .lean<(RecipientRecord & { createdAt?: Date; updatedAt?: Date; disabledAt?: Date })[]>();

  return { recipients: recipients.map(toRecipientDto) };
}

export async function createRecipient(actor: AutomationActor, input: CreateRecipientInput): Promise<RecipientDto> {
  await ensureActorApp(actor);
  validateRecipientAddress(input.serviceAddress);

  const recipientId = newRecipientId();
  const record = await RecipientModel.create({
    recipientId,
    ownerWalletId: actor.ownerWalletId,
    appId: actor.appId,
    name: input.name.trim(),
    serviceAddress: input.serviceAddress.trim(),
    addressType: 'ckb',
    externalId: cleanOptionalString(input.externalId),
    invoiceEndpoint: cleanOptionalString(input.invoiceEndpoint),
    status: 'active',
    metadata: input.metadata
  });

  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: AUTOMATION_AUDIT_ACTIONS.recipientCreated,
    targetType: 'recipient',
    targetId: recipientId,
    metadata: auditMetadata(actor, { externalId: cleanOptionalString(input.externalId) })
  });

  return toRecipientDto(record.toObject());
}

export async function updateRecipient(actor: AutomationActor, recipientId: string, input: UpdateRecipientInput): Promise<RecipientDto> {
  await ensureActorApp(actor);

  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};

  if (input.name !== undefined) set.name = input.name.trim();
  if (input.serviceAddress !== undefined) {
    validateRecipientAddress(input.serviceAddress);
    set.serviceAddress = input.serviceAddress.trim();
    set.addressType = 'ckb';
  }
  if (input.externalId !== undefined) {
    const externalId = cleanOptionalString(input.externalId);
    if (externalId) set.externalId = externalId;
    else unset.externalId = 1;
  }
  if (input.invoiceEndpoint !== undefined) {
    const invoiceEndpoint = cleanOptionalString(input.invoiceEndpoint);
    if (invoiceEndpoint) set.invoiceEndpoint = invoiceEndpoint;
    else unset.invoiceEndpoint = 1;
  }
  if (input.metadata !== undefined) set.metadata = input.metadata;

  const update: Record<string, unknown> = {};
  if (Object.keys(set).length > 0) update.$set = set;
  if (Object.keys(unset).length > 0) update.$unset = unset;

  if (Object.keys(update).length === 0) {
    throw new ApiError(400, 'RECIPIENT_UPDATE_EMPTY', 'At least one recipient field must be changed.');
  }

  const recipient = await RecipientModel.findOneAndUpdate(
    { recipientId, appId: actor.appId, ownerWalletId: actor.ownerWalletId, status: 'active' },
    update,
    { new: true }
  );

  if (!recipient) {
    throw new ApiError(404, 'RECIPIENT_NOT_FOUND', 'Recipient was not found for this app.');
  }

  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: AUTOMATION_AUDIT_ACTIONS.recipientUpdated,
    targetType: 'recipient',
    targetId: recipientId,
    metadata: auditMetadata(actor, { changedFields: Object.keys(set).concat(Object.keys(unset)) })
  });

  return toRecipientDto(recipient.toObject());
}

export async function disableRecipient(actor: AutomationActor, recipientId: string): Promise<RecipientDto> {
  await ensureActorApp(actor);

  const recipient = await RecipientModel.findOneAndUpdate(
    { recipientId, appId: actor.appId, ownerWalletId: actor.ownerWalletId, status: 'active' },
    { $set: { status: 'disabled', disabledAt: new Date() } },
    { new: true }
  );

  if (!recipient) {
    throw new ApiError(404, 'RECIPIENT_NOT_FOUND', 'Active recipient was not found for this app.');
  }

  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: AUTOMATION_AUDIT_ACTIONS.recipientDisabled,
    targetType: 'recipient',
    targetId: recipientId,
    metadata: auditMetadata(actor)
  });

  return toRecipientDto(recipient.toObject());
}

export async function listInvoices(actor: AutomationActor, sessionId?: string): Promise<{ invoices: InvoiceDto[] }> {
  await ensureActorApp(actor);
  const invoices = await InvoiceModel.find({
    appId: actor.appId,
    ownerWalletId: actor.ownerWalletId,
    ...(sessionId ? { sessionId } : {})
  }).sort({ createdAt: -1 }).limit(200).lean<(InvoiceRecord & { createdAt?: Date; updatedAt?: Date })[]>();

  return { invoices: invoices.map(toInvoiceDto) };
}

export async function createInvoice(actor: AutomationActor, input: CreateInvoiceInput): Promise<InvoiceDto> {
  const app = await ensureActorApp(actor);
  await getRecipientForInvoice(actor, input.recipientId);
  const session = await getAutomationSession(actor, input.sessionId, app);
  const amountMinor = toMinorUnits(String(input.amount), session.currency);
  if (amountMinor <= 0) {
    throw new ApiError(400, 'INVALID_INVOICE_AMOUNT', 'Invoice amount must be greater than zero.');
  }

  await validateInvoiceCapacity({ actor, session, sessionId: input.sessionId, newAmountMinor: amountMinor });
  const invoiceRecord = buildInvoiceRecord({ actor, sessionId: input.sessionId, invoice: input, amountMinor, currency: session.currency });
  const invoice = await InvoiceModel.create(invoiceRecord);

  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: AUTOMATION_AUDIT_ACTIONS.invoiceCreated,
    targetType: 'invoice',
    targetId: invoice.invoiceId,
    metadata: auditMetadata(actor, {
      sessionId: input.sessionId,
      recipientId: input.recipientId,
      amountMinor,
      hasFiberInvoice: Boolean(normalizeFiberInvoice(input.fiberInvoice))
    })
  });

  return toInvoiceDto(invoice.toObject());
}

export async function createInvoiceBatch(actor: AutomationActor, input: CreateInvoiceBatchInput): Promise<PaymentBatchDto> {
  const app = await ensureActorApp(actor);
  if (input.invoices.length === 0) {
    throw new ApiError(400, 'BATCH_EMPTY', 'Invoice batch must include at least one invoice.');
  }

  const session = await getAutomationSession(actor, input.sessionId, app);
  const batchId = newBatchId();
  let totalAmountMinor = 0;
  const invoiceRecords: Record<string, unknown>[] = [];

  for (const invoice of input.invoices) {
    await getRecipientForInvoice(actor, invoice.recipientId);
    const amountMinor = toMinorUnits(String(invoice.amount), session.currency);
    if (amountMinor <= 0) {
      throw new ApiError(400, 'INVALID_INVOICE_AMOUNT', 'Invoice amount must be greater than zero.');
    }
    totalAmountMinor += amountMinor;
    invoiceRecords.push(buildInvoiceRecord({ actor, sessionId: input.sessionId, batchId, invoice, amountMinor, currency: session.currency }));
  }

  await validateInvoiceCapacity({ actor, session, sessionId: input.sessionId, newAmountMinor: totalAmountMinor });

  const batch = await PaymentBatchModel.create({
    batchId,
    ownerWalletId: actor.ownerWalletId,
    appId: actor.appId,
    sessionId: input.sessionId,
    status: 'draft',
    description: cleanOptionalString(input.description) ?? '',
    externalReference: cleanOptionalString(input.externalReference),
    idempotencyKey: cleanOptionalString(input.idempotencyKey),
    totalAmount: fromMinorUnits(totalAmountMinor, session.currency),
    totalAmountMinor,
    currency: session.currency,
    invoiceCount: invoiceRecords.length,
    paidCount: 0,
    failedCount: 0,
    metadata: input.metadata
  });
  await InvoiceModel.insertMany(invoiceRecords);
  const invoices = await InvoiceModel.find({ batchId }).sort({ createdAt: 1 }).lean<(InvoiceRecord & { createdAt?: Date; updatedAt?: Date })[]>();

  await writeAuditLog({
    actorWalletId: actor.ownerWalletId,
    action: AUTOMATION_AUDIT_ACTIONS.batchCreated,
    targetType: 'payment_batch',
    targetId: batchId,
    metadata: auditMetadata(actor, {
      sessionId: input.sessionId,
      invoiceCount: invoiceRecords.length,
      totalAmountMinor
    })
  });

  return toPaymentBatchDto(batch.toObject(), invoices.map(toInvoiceDto));
}

