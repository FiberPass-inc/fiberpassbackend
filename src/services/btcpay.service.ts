import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { btcpayConnector } from '../connectors/btcpayConnector.js';
import { BtcpayGreenfieldClient } from '../connectors/btcpayClient.js';
import { formatMsatAsBtc, msatToSats, parseBitcoinDestination, parseBtcDecimalToMsat } from '../connectors/bitcoinProtocol.js';
import { decodeLightningInvoice } from '../connectors/nwcProtocol.js';
import { requiredBtcpayPermissions, type BitcoinNetwork, type BtcpayInvoiceStatus, type BtcpayScopeType } from '../domain/bitcoin.js';
import { asAssetId, moneyValue, type PaymentIntent, type PaymentResult } from '../domain/payment.js';
import { ApiError } from '../lib/errors.js';
import { asAtomicAmount } from '../lib/money.js';
import { AppModel } from '../models/app.model.js';
import {
  BtcpayConnectionModel,
  BtcpayInvoiceModel,
  BtcpayPaymentModel,
  type BtcpayConnectionRecord,
  type BtcpayInvoiceRecord,
  type BtcpayPaymentRecord
} from '../models/bitcoin.model.js';
import { SessionModel } from '../models/session.model.js';
import { writeAuditLog } from './audit.service.js';
import { decryptBtcpayApiKey, encryptBtcpayApiKey } from './btcpayCredential.service.js';

const BTC_ASSET_ID = asAssetId('bitcoin:btc');
const PAYMENT_LEASE_MS = 60_000;

interface ApiKeyResponse {
  apiKey?: unknown;
  permissions?: unknown;
  label?: unknown;
}

interface ProviderPaymentMethod {
  paymentMethodId?: unknown;
  destination?: unknown;
  paymentLink?: unknown;
  amount?: unknown;
}

interface ProviderInvoice {
  id?: unknown;
  storeId?: unknown;
  amount?: unknown;
  currency?: unknown;
  status?: unknown;
  checkoutLink?: unknown;
  expirationTime?: unknown;
  createdTime?: unknown;
  paymentMethods?: unknown;
  metadata?: unknown;
}

export interface PairBtcpayInput {
  serverUrl: string;
  storeId: string;
  apiKey: string;
  network: BitcoinNetwork;
  scopeType: BtcpayScopeType;
  scopeId?: string;
}

export interface BtcpayConnectionDto {
  id: string;
  status: string;
  connectorId: 'btcpay-greenfield';
  scope: { type: BtcpayScopeType; id: string };
  network: BitcoinNetwork;
  serverOrigin: string;
  storeId: string;
  keyFingerprint: string;
  permissions: string[];
  remoteRevoked: boolean;
  createdAt: string;
  revokedAt?: string;
}

export interface BtcpayInvoiceDto {
  id: string;
  connectionId: string;
  providerInvoiceId: string;
  rail: 'lightning' | 'bitcoin_onchain';
  network: BitcoinNetwork;
  assetId: 'bitcoin:btc';
  atomicUnit: 'millisatoshi';
  amountAtomic: string;
  status: BtcpayInvoiceStatus;
  paymentRequest?: string;
  checkoutLink?: string;
  expiresAt?: string;
  paidAt?: string;
}

export interface BtcpayPaymentDto {
  id: string;
  connectionId: string;
  status: string;
  network: BitcoinNetwork;
  assetId: 'bitcoin:btc';
  atomicUnit: 'millisatoshi';
  amountAtomic: string;
  feeAtomic: string;
  maxFeeAtomic: string;
  paymentHash: string;
  proof?: { kind: 'payment_hash'; reference: string; preimageVerified: true; providerPaymentId?: string };
  failure?: { code: string; message?: string };
  submittedAt?: string;
  reconciledAt?: string;
  succeededAt?: string;
}

const defaultClient = new BtcpayGreenfieldClient({
  timeoutMs: env.BTCPAY_REQUEST_TIMEOUT_MS,
  allowInsecureLocal: env.BTCPAY_ALLOW_INSECURE_LOCAL
});

function isDuplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 11000);
}

function keyFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requestFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function safeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}

function normalizeOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(400, 'BTCPAY_URL_INVALID', 'BTCPay server URL is invalid.');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new ApiError(400, 'BTCPAY_URL_INVALID', 'BTCPay server URL must be a credential-free origin.');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function assertScopeOwnership(ownerWalletId: string, scopeType: BtcpayScopeType, requestedScopeId?: string): Promise<string> {
  if (scopeType === 'wallet') return ownerWalletId;
  const scopeId = requestedScopeId?.trim();
  if (!scopeId) throw new ApiError(400, 'BTCPAY_SCOPE_ID_REQUIRED', 'Pass and app BTCPay connections require a scope id.');
  const owned = scopeType === 'pass'
    ? await SessionModel.exists({ publicId: scopeId, ownerWalletId })
    : await AppModel.exists({ appId: scopeId, ownerWalletId, status: 'active' });
  if (!owned) throw new ApiError(404, 'BTCPAY_SCOPE_NOT_FOUND', 'BTCPay connection scope was not found for this wallet.');
  return scopeId;
}

function toConnectionDto(connection: BtcpayConnectionRecord & { createdAt?: Date }): BtcpayConnectionDto {
  return {
    id: connection.connectionId,
    status: connection.status,
    connectorId: 'btcpay-greenfield',
    scope: { type: connection.scopeType, id: connection.scopeId },
    network: connection.network,
    serverOrigin: connection.serverOrigin,
    storeId: connection.storeId,
    keyFingerprint: connection.apiKeyFingerprint.slice(0, 16),
    permissions: [...connection.permissions],
    remoteRevoked: connection.remoteRevoked,
    createdAt: (connection.createdAt ?? new Date()).toISOString(),
    revokedAt: connection.revokedAt?.toISOString()
  };
}

function toPaymentDto(payment: BtcpayPaymentRecord): BtcpayPaymentDto {
  return {
    id: payment.paymentId,
    connectionId: payment.connectionId,
    status: payment.status,
    network: payment.network,
    assetId: 'bitcoin:btc',
    atomicUnit: 'millisatoshi',
    amountAtomic: payment.amountAtomic,
    feeAtomic: payment.feeAtomic,
    maxFeeAtomic: payment.maxFeeAtomic,
    paymentHash: payment.paymentHash,
    proof: payment.status === 'succeeded' && payment.preimageVerified ? {
      kind: 'payment_hash',
      reference: payment.paymentHash,
      preimageVerified: true,
      providerPaymentId: payment.providerPaymentId ?? undefined
    } : undefined,
    failure: payment.failureCode ? { code: payment.failureCode, message: payment.failureMessage ?? undefined } : undefined,
    submittedAt: payment.submittedAt?.toISOString(),
    reconciledAt: payment.reconciledAt?.toISOString(),
    succeededAt: payment.succeededAt?.toISOString()
  };
}

function invoiceStatus(value: unknown): BtcpayInvoiceStatus {
  const status = typeof value === 'string' ? value.toLowerCase() : '';
  if (status === 'new') return 'new';
  if (status === 'processing') return 'processing';
  if (status === 'settled') return 'settled';
  if (status === 'expired') return 'expired';
  if (status === 'invalid') return 'invalid';
  throw new ApiError(502, 'BTCPAY_INVOICE_RESPONSE_INVALID', 'BTCPay returned an unknown invoice status.');
}

function providerTime(value: unknown): Date | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return new Date(value * 1000);
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value);
  return undefined;
}

function providerRequest(body: ProviderInvoice, rail: 'lightning' | 'bitcoin_onchain'): string {
  if (!Array.isArray(body.paymentMethods)) throw new ApiError(502, 'BTCPAY_PAYMENT_METHOD_MISSING', 'BTCPay invoice has no requested payment method.');
  const expectedMethod = rail === 'lightning' ? 'BTC-LN' : 'BTC-CHAIN';
  const method = (body.paymentMethods as ProviderPaymentMethod[]).find((item) => item?.paymentMethodId === expectedMethod);
  if (!method) throw new ApiError(502, 'BTCPAY_PAYMENT_METHOD_MISSING', 'BTCPay invoice did not provide the requested Bitcoin payment method.');
  const link = typeof method.paymentLink === 'string' ? method.paymentLink.trim() : '';
  const destination = typeof method.destination === 'string' ? method.destination.trim() : '';
  const value = link || destination;
  if (!value) throw new ApiError(502, 'BTCPAY_PAYMENT_METHOD_MISSING', 'BTCPay invoice payment request is missing.');
  if (rail === 'lightning') return value.replace(/^lightning:/i, '');
  return value;
}

async function loadConnection(connectionId: string, ownerWalletId: string): Promise<{ connection: BtcpayConnectionRecord; apiKey: string }> {
  const connection = await BtcpayConnectionModel.findOne({ connectionId, ownerWalletId, status: 'active' })
    .select('+apiKeyCiphertext')
    .lean<BtcpayConnectionRecord | null>();
  if (!connection) throw new ApiError(404, 'BTCPAY_CONNECTION_NOT_FOUND', 'Active BTCPay connection was not found.');
  return { connection, apiKey: decryptBtcpayApiKey(connection.apiKeyCiphertext) };
}

export async function pairBtcpayConnection(
  input: PairBtcpayInput,
  ownerWalletId: string,
  client: BtcpayGreenfieldClient = defaultClient
): Promise<BtcpayConnectionDto> {
  const scopeId = await assertScopeOwnership(ownerWalletId, input.scopeType, input.scopeId);
  const storeId = input.storeId.trim();
  if (!/^[A-Za-z0-9_-]{3,128}$/.test(storeId)) throw new ApiError(400, 'BTCPAY_STORE_ID_INVALID', 'BTCPay store id format is invalid.');
  const fingerprint = keyFingerprint(input.apiKey);
  if (await BtcpayConnectionModel.exists({ apiKeyFingerprint: fingerprint })) {
    throw new ApiError(409, 'BTCPAY_API_KEY_REUSED', 'This BTCPay API key is already paired. Create a separate store-scoped key.');
  }
  const serverOrigin = normalizeOrigin(input.serverUrl);
  const current = await client.request<ApiKeyResponse>({
    serverUrl: serverOrigin,
    apiKey: input.apiKey,
    method: 'GET',
    path: '/api/v1/api-keys/current'
  });
  if (current.status !== 200 || !current.body || typeof current.body !== 'object') {
    throw new ApiError(409, 'BTCPAY_API_KEY_REJECTED', 'BTCPay did not accept the API key.');
  }
  if (typeof current.body.apiKey !== 'string' || !safeEqual(current.body.apiKey, input.apiKey)) {
    throw new ApiError(409, 'BTCPAY_API_KEY_MISMATCH', 'BTCPay key identity did not match the submitted credential.');
  }
  const permissions = Array.isArray(current.body.permissions)
    ? current.body.permissions.filter((permission): permission is string => typeof permission === 'string').sort()
    : [];
  const required = requiredBtcpayPermissions(storeId).sort();
  if (permissions.length !== required.length || required.some((permission, index) => permissions[index] !== permission)) {
    throw new ApiError(409, 'BTCPAY_LEAST_PRIVILEGE_REQUIRED', 'BTCPay API key must contain only the required permissions scoped to this store.', {
      requiredPermissions: required
    });
  }
  let created;
  try {
    created = await BtcpayConnectionModel.create({
      connectionId: 'btcpay_' + randomUUID(),
      ownerWalletId,
      scopeType: input.scopeType,
      scopeId,
      network: input.network,
      serverOrigin,
      storeId,
      apiKeyCiphertext: encryptBtcpayApiKey(input.apiKey),
      apiKeyFingerprint: fingerprint,
      permissions,
      status: 'active',
      lastUsedAt: new Date()
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw new ApiError(409, 'BTCPAY_API_KEY_REUSED', 'This BTCPay API key is already paired.');
    throw error;
  }
  await writeAuditLog({
    actorWalletId: ownerWalletId,
    action: 'btcpay.connection.paired',
    targetType: 'btcpay_connection',
    targetId: created.connectionId,
    metadata: { scopeType: input.scopeType, scopeId, network: input.network, storeId, keyFingerprint: fingerprint, permissions }
  });
  return toConnectionDto(created.toObject());
}

export async function listBtcpayConnections(ownerWalletId: string): Promise<{ connections: BtcpayConnectionDto[] }> {
  const connections = await BtcpayConnectionModel.find({ ownerWalletId }).sort({ createdAt: -1 }).lean<Array<BtcpayConnectionRecord & { createdAt?: Date }>>();
  return { connections: connections.map(toConnectionDto) };
}

export async function disconnectBtcpayConnection(
  connectionId: string,
  ownerWalletId: string,
  reason?: string,
  client: BtcpayGreenfieldClient = defaultClient
): Promise<{ remoteRevoked: boolean }> {
  const loaded = await loadConnection(connectionId, ownerWalletId);
  let remoteRevoked = false;
  try {
    const response = await client.request({
      serverUrl: loaded.connection.serverOrigin,
      apiKey: loaded.apiKey,
      method: 'DELETE',
      path: '/api/v1/api-keys/current'
    });
    remoteRevoked = response.status >= 200 && response.status < 300;
  } catch {
    remoteRevoked = false;
  }
  await BtcpayConnectionModel.updateOne(
    { connectionId, ownerWalletId, status: 'active' },
    {
      $set: {
        status: 'revoked',
        revokedAt: new Date(),
        revokeReason: reason?.trim().slice(0, 160) || 'Disconnected by owner',
        remoteRevoked,
        serverOrigin: '',
        storeId: ''
      },
      $unset: { apiKeyCiphertext: 1 }
    }
  );
  await writeAuditLog({
    actorWalletId: ownerWalletId,
    action: 'btcpay.connection.disconnected',
    targetType: 'btcpay_connection',
    targetId: connectionId,
    metadata: { remoteRevoked }
  });
  return { remoteRevoked };
}

async function fetchProviderInvoice(input: {
  record: BtcpayInvoiceRecord;
  connection: BtcpayConnectionRecord;
  apiKey: string;
  client: BtcpayGreenfieldClient;
}): Promise<BtcpayInvoiceDto> {
  if (!input.record.providerInvoiceId) {
    throw new ApiError(503, 'BTCPAY_INVOICE_OUTCOME_UNCERTAIN', 'BTCPay invoice creation is still being reconciled.');
  }
  const response = await input.client.request<ProviderInvoice>({
    serverUrl: input.connection.serverOrigin,
    apiKey: input.apiKey,
    method: 'GET',
    path: '/api/v1/stores/' + encodeURIComponent(input.connection.storeId)
      + '/invoices/' + encodeURIComponent(input.record.providerInvoiceId) + '?includePaymentMethods=true'
  });
  if (response.status !== 200 || !response.body || typeof response.body !== 'object') {
    throw new ApiError(502, 'BTCPAY_INVOICE_LOOKUP_FAILED', 'BTCPay invoice status could not be loaded.');
  }
  if (response.body.id !== input.record.providerInvoiceId || response.body.storeId !== input.connection.storeId || response.body.currency !== 'BTC') {
    throw new ApiError(502, 'BTCPAY_INVOICE_RESPONSE_INVALID', 'BTCPay invoice identity does not match the stored request.');
  }
  const amountAtomic = parseBtcDecimalToMsat(response.body.amount, { onchain: true, field: 'BTCPay invoice amount' });
  if (BigInt(amountAtomic) !== BigInt(input.record.amountAtomic)) throw new ApiError(502, 'BTCPAY_INVOICE_AMOUNT_MISMATCH', 'BTCPay invoice amount changed.');
  const paymentRequest = providerRequest(response.body, input.record.rail);
  if (input.record.rail === 'lightning') {
    decodeLightningInvoice({ invoice: paymentRequest, network: input.record.network, expectedAmountAtomic: input.record.amountAtomic });
  } else {
    parseBitcoinDestination({ destination: paymentRequest, network: input.record.network, expectedAmountAtomic: input.record.amountAtomic });
  }
  const status = invoiceStatus(response.body.status);
  const paymentRequestHash = createHash('sha256').update(paymentRequest).digest('hex');
  const expiresAt = providerTime(response.body.expirationTime) ?? input.record.expiresAt;
  const paidAt = status === 'settled' ? input.record.paidAt ?? new Date() : undefined;
  await BtcpayInvoiceModel.updateOne(
    { invoiceId: input.record.invoiceId },
    { $set: { status, paymentRequestHash, expiresAt, paidAt } }
  );
  return {
    id: input.record.invoiceId,
    connectionId: input.record.connectionId,
    providerInvoiceId: input.record.providerInvoiceId,
    rail: input.record.rail,
    network: input.record.network,
    assetId: 'bitcoin:btc',
    atomicUnit: 'millisatoshi',
    amountAtomic: input.record.amountAtomic,
    status,
    paymentRequest,
    checkoutLink: typeof response.body.checkoutLink === 'string' ? response.body.checkoutLink : input.record.checkoutLink ?? undefined,
    expiresAt: expiresAt?.toISOString(),
    paidAt: paidAt?.toISOString()
  };
}

function assertProviderInvoiceIdentity(input: {
  body: ProviderInvoice;
  connection: BtcpayConnectionRecord;
  record: BtcpayInvoiceRecord;
}): asserts input is { body: ProviderInvoice & { id: string }; connection: BtcpayConnectionRecord; record: BtcpayInvoiceRecord } {
  const metadata = input.body.metadata && typeof input.body.metadata === 'object'
    ? input.body.metadata as { orderId?: unknown }
    : undefined;
  const amountAtomic = parseBtcDecimalToMsat(input.body.amount, { onchain: true, field: 'BTCPay invoice amount' });
  if (
    typeof input.body.id !== 'string'
    || input.body.storeId !== input.connection.storeId
    || input.body.currency !== 'BTC'
    || metadata?.orderId !== input.record.invoiceId
    || BigInt(amountAtomic) !== BigInt(input.record.amountAtomic)
  ) {
    throw new ApiError(502, 'BTCPAY_INVOICE_RESPONSE_INVALID', 'BTCPay invoice identity does not match the reserved request.');
  }
}

async function finishInvoiceCreation(input: {
  record: BtcpayInvoiceRecord;
  provider: ProviderInvoice;
  connection: BtcpayConnectionRecord;
  apiKey: string;
  client: BtcpayGreenfieldClient;
}): Promise<BtcpayInvoiceDto> {
  assertProviderInvoiceIdentity({ body: input.provider, connection: input.connection, record: input.record });
  const updated = await BtcpayInvoiceModel.findOneAndUpdate(
    { invoiceId: input.record.invoiceId, requestFingerprint: input.record.requestFingerprint },
    {
      $set: {
        providerInvoiceId: input.provider.id,
        creationStatus: 'ready',
        status: invoiceStatus(input.provider.status),
        checkoutLink: typeof input.provider.checkoutLink === 'string' ? input.provider.checkoutLink : undefined,
        expiresAt: providerTime(input.provider.expirationTime)
      },
      $unset: { creationLeaseExpiresAt: 1 }
    },
    { new: true }
  ).lean<BtcpayInvoiceRecord | null>();
  if (!updated) throw new ApiError(503, 'BTCPAY_INVOICE_STATE_FAILED', 'BTCPay invoice state could not be persisted.');
  return fetchProviderInvoice({ record: updated, connection: input.connection, apiKey: input.apiKey, client: input.client });
}

async function recoverInvoiceCreation(input: {
  record: BtcpayInvoiceRecord;
  connection: BtcpayConnectionRecord;
  apiKey: string;
  client: BtcpayGreenfieldClient;
}): Promise<BtcpayInvoiceDto> {
  if (input.record.providerInvoiceId && input.record.creationStatus === 'ready') {
    return fetchProviderInvoice(input);
  }
  const response = await input.client.request<ProviderInvoice[]>({
    serverUrl: input.connection.serverOrigin,
    apiKey: input.apiKey,
    method: 'GET',
    path: '/api/v1/stores/' + encodeURIComponent(input.connection.storeId)
      + '/invoices?orderId=' + encodeURIComponent(input.record.invoiceId) + '&includePaymentMethods=true&take=2'
  });
  if (response.status !== 200 || !Array.isArray(response.body)) {
    throw new ApiError(503, 'BTCPAY_INVOICE_RECOVERY_FAILED', 'BTCPay invoice creation could not be reconciled.');
  }
  if (response.body.length > 1) {
    throw new ApiError(503, 'BTCPAY_INVOICE_DUPLICATE_REMOTE', 'BTCPay returned multiple invoices for one reserved request.');
  }
  if (response.body.length === 1) return finishInvoiceCreation({ ...input, provider: response.body[0] });
  const inFlight = input.record.creationStatus === 'creating'
    && Boolean(input.record.creationLeaseExpiresAt && input.record.creationLeaseExpiresAt.getTime() > Date.now());
  if (inFlight) throw new ApiError(409, 'BTCPAY_INVOICE_CREATION_IN_PROGRESS', 'BTCPay invoice creation is already in progress.');
  await BtcpayInvoiceModel.updateOne(
    { invoiceId: input.record.invoiceId, creationStatus: 'creating' },
    { $set: { creationStatus: 'uncertain' }, $unset: { creationLeaseExpiresAt: 1 } }
  );
  throw new ApiError(503, 'BTCPAY_INVOICE_OUTCOME_UNCERTAIN', 'BTCPay invoice creation is not visible yet; retry status reconciliation later.');
}

export async function createBtcpayInvoice(input: {
  connectionId: string;
  ownerWalletId: string;
  rail: 'lightning' | 'bitcoin_onchain';
  amountAtomic: string;
  idempotencyKey: string;
}, client: BtcpayGreenfieldClient = defaultClient): Promise<BtcpayInvoiceDto> {
  const loaded = await loadConnection(input.connectionId, input.ownerWalletId);
  const amountAtomic = asAtomicAmount(input.amountAtomic);
  if (BigInt(amountAtomic) <= 0n) throw new ApiError(400, 'BTCPAY_INVOICE_AMOUNT_INVALID', 'BTCPay invoice amount must be positive.');
  msatToSats(amountAtomic, 'BTCPay receive amount');
  const fingerprint = requestFingerprint({
    connectionId: input.connectionId,
    ownerWalletId: input.ownerWalletId,
    rail: input.rail,
    amountAtomic,
    network: loaded.connection.network,
    idempotencyKey: input.idempotencyKey
  });
  const existing = await BtcpayInvoiceModel.findOne({
    ownerWalletId: input.ownerWalletId,
    connectionId: input.connectionId,
    idempotencyKey: input.idempotencyKey
  }).lean<BtcpayInvoiceRecord | null>();
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) throw new ApiError(409, 'BTCPAY_IDEMPOTENCY_CONFLICT', 'BTCPay invoice idempotency key was used for another request.');
    return recoverInvoiceCreation({ record: existing, ...loaded, client });
  }

  const invoiceId = 'btci_' + randomUUID();
  let record: BtcpayInvoiceRecord;
  try {
    const created = await BtcpayInvoiceModel.create({
      invoiceId,
      connectionId: input.connectionId,
      ownerWalletId: input.ownerWalletId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      rail: input.rail,
      network: loaded.connection.network,
      assetId: BTC_ASSET_ID,
      moneyContractVersion: 2,
      amountAtomic,
      creationStatus: 'creating',
      creationLeaseExpiresAt: new Date(Date.now() + PAYMENT_LEASE_MS),
      status: 'new'
    });
    record = created.toObject();
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    const raced = await BtcpayInvoiceModel.findOne({
      ownerWalletId: input.ownerWalletId,
      connectionId: input.connectionId,
      idempotencyKey: input.idempotencyKey
    }).lean<BtcpayInvoiceRecord | null>();
    if (!raced) throw new ApiError(409, 'BTCPAY_INVOICE_DUPLICATE', 'BTCPay invoice creation is already in progress.');
    if (raced.requestFingerprint !== fingerprint) throw new ApiError(409, 'BTCPAY_IDEMPOTENCY_CONFLICT', 'BTCPay invoice idempotency key was used for another request.');
    return recoverInvoiceCreation({ record: raced, ...loaded, client });
  }
  let response;
  try {
    response = await client.request<ProviderInvoice>({
      serverUrl: loaded.connection.serverOrigin,
      apiKey: loaded.apiKey,
      method: 'POST',
      path: '/api/v1/stores/' + encodeURIComponent(loaded.connection.storeId) + '/invoices',
      body: {
        amount: formatMsatAsBtc(amountAtomic),
        currency: 'BTC',
        metadata: { orderId: invoiceId },
        checkout: {
          paymentMethods: [input.rail === 'lightning' ? 'BTC-LN' : 'BTC-CHAIN'],
          expirationMinutes: 15,
          paymentTolerance: 0
        }
      }
    });
  } catch {
    await BtcpayInvoiceModel.updateOne(
      { invoiceId },
      { $set: { creationStatus: 'uncertain' }, $unset: { creationLeaseExpiresAt: 1 } }
    );
    throw new ApiError(503, 'BTCPAY_INVOICE_OUTCOME_UNCERTAIN', 'BTCPay invoice creation outcome requires reconciliation.');
  }
  if (response.status !== 200 || !response.body || typeof response.body !== 'object') {
    await BtcpayInvoiceModel.updateOne(
      { invoiceId },
      { $set: { creationStatus: 'uncertain' }, $unset: { creationLeaseExpiresAt: 1 } }
    );
    throw new ApiError(502, 'BTCPAY_INVOICE_CREATE_FAILED', 'BTCPay invoice could not be created.');
  }
  const invoice = await finishInvoiceCreation({ record, provider: response.body, ...loaded, client });
  await writeAuditLog({
    actorWalletId: input.ownerWalletId,
    action: 'btcpay.invoice.created',
    targetType: 'btcpay_invoice',
    targetId: invoiceId,
    metadata: { connectionId: input.connectionId, rail: input.rail, network: loaded.connection.network, amountAtomic }
  });
  return invoice;
}

export async function getBtcpayInvoice(input: {
  connectionId: string;
  invoiceId: string;
  ownerWalletId: string;
}, client: BtcpayGreenfieldClient = defaultClient): Promise<BtcpayInvoiceDto> {
  const record = await BtcpayInvoiceModel.findOne(input).lean<BtcpayInvoiceRecord | null>();
  if (!record) throw new ApiError(404, 'BTCPAY_INVOICE_NOT_FOUND', 'BTCPay invoice was not found.');
  const loaded = await loadConnection(input.connectionId, input.ownerWalletId);
  return fetchProviderInvoice({ record, ...loaded, client });
}

function paymentIntent(paymentId: string, idempotencyKey: string, invoice: string, network: BitcoinNetwork, amountAtomic: string, expiresAt: string): PaymentIntent {
  return {
    intentId: paymentId,
    idempotencyKey,
    rail: 'lightning',
    network,
    money: moneyValue(BTC_ASSET_ID, amountAtomic),
    destination: { kind: 'invoice', rail: 'lightning', network, value: invoice },
    expiresAt
  };
}

function executionInFlight(payment: BtcpayPaymentRecord): boolean {
  return payment.status === 'pending'
    && Boolean(payment.executionLeaseId)
    && Boolean(payment.executionLeaseExpiresAt && payment.executionLeaseExpiresAt.getTime() > Date.now());
}

async function persistPaymentResult(payment: BtcpayPaymentRecord, result: PaymentResult, reconciled: boolean): Promise<BtcpayPaymentRecord> {
  const now = new Date();
  const status = result.status === 'succeeded' ? 'succeeded' : result.status === 'failed' ? 'failed' : result.status === 'uncertain' ? 'uncertain' : 'pending';
  const set: Record<string, unknown> = {
    status,
    feeAtomic: result.proof?.metadata?.feeAtomic ?? payment.feeAtomic,
    preimageVerified: result.proof?.metadata?.preimageVerified === 'true',
    executionLeaseExpiresAt: now
  };
  if (result.proof?.metadata?.providerPaymentId) set.providerPaymentId = result.proof.metadata.providerPaymentId;
  if (reconciled) set.reconciledAt = now;
  if (status === 'succeeded') set.succeededAt = now;
  if (status === 'failed') set.failedAt = now;
  if (result.failureCode) set.failureCode = result.failureCode;
  if (result.failureMessage) set.failureMessage = result.failureMessage;
  const unset: Record<string, 1> = { executionLeaseId: 1 };
  if (!result.failureCode) unset.failureCode = 1;
  if (!result.failureMessage) unset.failureMessage = 1;
  if (status !== 'succeeded') unset.succeededAt = 1;
  if (status !== 'failed') unset.failedAt = 1;
  const updated = await BtcpayPaymentModel.findOneAndUpdate(
    { paymentId: payment.paymentId, status: { $in: ['pending', 'uncertain'] } },
    {
      $set: set,
      $unset: unset
    },
    { new: true }
  ).lean<BtcpayPaymentRecord | null>();
  if (updated) return updated;
  const existing = await BtcpayPaymentModel.findOne({ paymentId: payment.paymentId }).lean<BtcpayPaymentRecord | null>();
  if (!existing) throw new ApiError(503, 'BTCPAY_PAYMENT_STATE_FAILED', 'BTCPay payment state could not be persisted.');
  return existing;
}

async function markPaymentUncertain(payment: BtcpayPaymentRecord): Promise<BtcpayPaymentRecord> {
  const updated = await BtcpayPaymentModel.findOneAndUpdate(
    { paymentId: payment.paymentId, status: { $in: ['pending', 'uncertain'] } },
    {
      $set: {
        status: 'uncertain',
        failureCode: 'BTCPAY_PAYMENT_OUTCOME_UNCERTAIN',
        failureMessage: 'BTCPay payment outcome must be reconciled before retry.',
        executionLeaseExpiresAt: new Date()
      },
      $unset: { executionLeaseId: 1 }
    },
    { new: true }
  ).lean<BtcpayPaymentRecord | null>();
  if (!updated) throw new ApiError(503, 'BTCPAY_PAYMENT_STATE_FAILED', 'BTCPay uncertainty could not be persisted.');
  return updated;
}

async function reconcilePayment(payment: BtcpayPaymentRecord): Promise<BtcpayPaymentDto> {
  try {
    const result = await btcpayConnector.lookup({
      rail: 'lightning',
      network: payment.network,
      assetId: BTC_ASSET_ID,
      reference: payment.paymentHash,
      ownerWalletId: payment.ownerWalletId,
      connectionId: payment.connectionId
    });
    return toPaymentDto(await persistPaymentResult(payment, result, true));
  } catch {
    return toPaymentDto(await markPaymentUncertain(payment));
  }
}

export async function payBtcpayLightning(input: {
  connectionId: string;
  ownerWalletId: string;
  invoice: string;
  idempotencyKey: string;
  maxFeeAtomic: string;
}): Promise<BtcpayPaymentDto> {
  const connection = await BtcpayConnectionModel.findOne({ connectionId: input.connectionId, ownerWalletId: input.ownerWalletId, status: 'active' })
    .lean<BtcpayConnectionRecord | null>();
  if (!connection) throw new ApiError(404, 'BTCPAY_CONNECTION_NOT_FOUND', 'Active BTCPay connection was not found.');
  const maxFeeAtomic = asAtomicAmount(input.maxFeeAtomic);
  msatToSats(maxFeeAtomic, 'BTCPay maximum fee');
  const invoice = decodeLightningInvoice({ invoice: input.invoice, network: connection.network });
  const fingerprint = requestFingerprint({
    connectionId: input.connectionId,
    ownerWalletId: input.ownerWalletId,
    idempotencyKey: input.idempotencyKey,
    paymentHash: invoice.paymentHash,
    invoiceHash: invoice.invoiceHash,
    amountAtomic: invoice.amountAtomic,
    maxFeeAtomic,
    network: connection.network
  });
  let existing = await BtcpayPaymentModel.findOne({
    ownerWalletId: input.ownerWalletId,
    $or: [
      { connectionId: input.connectionId, idempotencyKey: input.idempotencyKey },
      { paymentHash: invoice.paymentHash }
    ]
  }).lean<BtcpayPaymentRecord | null>();
  if (existing) {
    if (existing.requestFingerprint !== fingerprint) throw new ApiError(409, 'BTCPAY_IDEMPOTENCY_CONFLICT', 'BTCPay idempotency key or invoice was used for another request.');
    if (existing.status === 'succeeded' || executionInFlight(existing)) return toPaymentDto(existing);
    if (existing.status === 'failed') throw new ApiError(409, existing.failureCode ?? 'BTCPAY_PAYMENT_FAILED', existing.failureMessage ?? 'BTCPay payment already failed.');
    return reconcilePayment(existing);
  }
  const paymentId = 'btcpaypay_' + randomUUID();
  const leaseId = randomUUID();
  try {
    const created = await BtcpayPaymentModel.create({
      paymentId,
      connectionId: input.connectionId,
      ownerWalletId: input.ownerWalletId,
      idempotencyKey: input.idempotencyKey,
      requestFingerprint: fingerprint,
      paymentHash: invoice.paymentHash,
      invoiceHash: invoice.invoiceHash,
      network: connection.network,
      assetId: BTC_ASSET_ID,
      moneyContractVersion: 2,
      amountAtomic: invoice.amountAtomic,
      feeAtomic: '0',
      maxFeeAtomic,
      status: 'pending',
      executionLeaseId: leaseId,
      executionLeaseExpiresAt: new Date(Date.now() + PAYMENT_LEASE_MS),
      submittedAt: new Date()
    });
    existing = created.toObject();
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    existing = await BtcpayPaymentModel.findOne({ ownerWalletId: input.ownerWalletId, paymentHash: invoice.paymentHash }).lean<BtcpayPaymentRecord | null>();
    if (!existing) throw new ApiError(409, 'BTCPAY_PAYMENT_DUPLICATE', 'BTCPay payment is already being processed.');
    if (existing.requestFingerprint !== fingerprint) throw new ApiError(409, 'BTCPAY_IDEMPOTENCY_CONFLICT', 'BTCPay invoice is assigned to another request.');
    return executionInFlight(existing) ? toPaymentDto(existing) : reconcilePayment(existing);
  }
  const intent = paymentIntent(paymentId, input.idempotencyKey, invoice.invoice, connection.network, invoice.amountAtomic, invoice.expiresAt);
  const quote = await btcpayConnector.quote(intent);
  try {
    const result = await btcpayConnector.execute(intent, quote, {
      ownerWalletId: input.ownerWalletId,
      metadata: { btcpayConnectionId: input.connectionId, btcpayMaxFeeAtomic: maxFeeAtomic }
    });
    const persisted = await persistPaymentResult(existing, result, false);
    await writeAuditLog({
      actorWalletId: input.ownerWalletId,
      action: result.status === 'succeeded' ? 'btcpay.payment.succeeded' : 'btcpay.payment.pending',
      targetType: 'btcpay_payment',
      targetId: paymentId,
      metadata: { connectionId: input.connectionId, paymentHash: invoice.paymentHash, amountAtomic: invoice.amountAtomic, network: connection.network }
    });
    return toPaymentDto(persisted);
  } catch {
    const uncertain = await markPaymentUncertain(existing);
    await writeAuditLog({
      actorWalletId: input.ownerWalletId,
      action: 'btcpay.payment.uncertain',
      targetType: 'btcpay_payment',
      targetId: paymentId,
      metadata: { connectionId: input.connectionId, paymentHash: invoice.paymentHash, amountAtomic: invoice.amountAtomic }
    });
    return toPaymentDto(uncertain);
  }
}

export async function getBtcpayPayment(input: {
  connectionId: string;
  ownerWalletId: string;
  paymentHash: string;
}): Promise<BtcpayPaymentDto> {
  const payment = await BtcpayPaymentModel.findOne({
    connectionId: input.connectionId,
    ownerWalletId: input.ownerWalletId,
    paymentHash: input.paymentHash.toLowerCase()
  }).lean<BtcpayPaymentRecord | null>();
  if (!payment) throw new ApiError(404, 'BTCPAY_PAYMENT_NOT_FOUND', 'BTCPay payment attempt was not found.');
  if (payment.status === 'pending' || payment.status === 'uncertain') return reconcilePayment(payment);
  return toPaymentDto(payment);
}
