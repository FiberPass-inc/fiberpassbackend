import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { RecipientModel } from '../models/automation.model.js';
import {
  ClaimChannelModel,
  NotificationEndpointModel,
  PaymentDestinationModel,
  RecipientClaimModel,
  RecipientIdentityModel,
  WalletPrincipalModel
} from '../models/identity.model.js';
import { SessionModel } from '../models/session.model.js';
import { WalletModel } from '../models/wallet.model.js';
import { hashContactValue, hashPrivateValue } from '../services/recipientIdentity.service.js';

function legacyId(prefix: string, value: string): string {
  return prefix + '_legacy_' + createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalDate(value: unknown): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value as string | number | Date);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export interface LegacySessionIdentityRecords {
  recipient: Record<string, unknown>;
  destination?: Record<string, unknown>;
  claimChannel?: Record<string, unknown>;
  notificationEndpoint?: Record<string, unknown>;
  claim?: Record<string, unknown>;
  embeddedFields: Record<string, unknown>;
}

export function buildLegacySessionIdentityRecords(
  session: Record<string, unknown>,
  wallet: Record<string, unknown>,
  index: number,
  now = new Date()
): LegacySessionIdentityRecords {
  const sessionId = String(session.publicId);
  const ownerWalletId = String(session.ownerWalletId);
  const source = sessionId + ':' + index;
  const recipientId = optionalString(wallet.recipientId) ?? legacyId('rcp', source);
  const claimChannelId = optionalString(wallet.claimChannelId) ?? (optionalString(wallet.email) ? legacyId('chn', source) : undefined);
  const notificationEndpointId = optionalString(wallet.notificationEndpointId) ?? (optionalString(wallet.email) ? legacyId('ntf', source) : undefined);
  const address = optionalString(wallet.address);
  const fiberInvoice = optionalString(wallet.fiberInvoice);
  const destinationValue = fiberInvoice ?? address;
  const destinationId = optionalString(wallet.destinationId) ?? (destinationValue ? legacyId('dst', source) : undefined);
  const destination = destinationValue && destinationId ? {
    destinationId,
    recipientId,
    ownerWalletId,
    rail: fiberInvoice ? 'fiber' : 'ckb_onchain',
    network: env.FIBER_NETWORK,
    kind: fiberInvoice ? 'invoice' : 'address',
    value: destinationValue,
    valueHash: hashPrivateValue(destinationValue),
    reusable: !fiberInvoice,
    status: 'active',
    verificationMethod: 'legacy_import',
    verificationScope: 'delivery_instruction',
    verifiedAt: optionalDate(wallet.inviteClaimedAt) ?? optionalDate(session.createdAt) ?? now
  } : undefined;
  const email = optionalString(wallet.email)?.toLowerCase();
  const claimChannel = email && claimChannelId ? {
    channelId: claimChannelId,
    recipientId,
    ownerWalletId,
    type: 'email',
    value: email,
    valueHash: hashContactValue(email),
    status: 'active',
    deliveryVerifiedAt: optionalDate(wallet.inviteClaimedAt)
  } : undefined;
  const notificationEndpoint = email && notificationEndpointId ? {
    endpointId: notificationEndpointId,
    recipientId,
    ownerWalletId,
    type: 'email',
    purpose: 'receipt',
    value: email,
    valueHash: hashContactValue(email),
    status: 'active'
  } : undefined;
  const tokenHash = optionalString(wallet.inviteTokenHash);
  const expiresAt = optionalDate(wallet.inviteTokenExpiresAt) ?? new Date(0);
  const claimedAt = optionalDate(wallet.inviteClaimedAt);
  const revoked = wallet.inviteStatus === 'revoked';
  const claimStatus = claimedAt ? 'claimed' : revoked ? 'revoked' : expiresAt.getTime() <= now.getTime() ? 'expired' : 'pending';
  const claimId = optionalString(wallet.claimId) ?? (tokenHash ? legacyId('clm', source) : undefined);
  const claim = tokenHash && claimId ? {
    claimId,
    recipientId,
    ownerWalletId,
    sessionId,
    sessionRecipientIndex: index,
    channelId: claimChannelId,
    tokenHash,
    purpose: 'bind_destination',
    status: claimStatus,
    expiresAt,
    claimedAt,
    revokedAt: revoked ? now : undefined,
    destinationId: claimedAt ? destinationId : undefined,
    contactVerifiedAt: claimedAt
  } : undefined;
  return {
    recipient: {
      recipientId,
      ownerWalletId,
      name: optionalString(wallet.name) ?? 'Recipient',
      sessionId,
      sessionRecipientIndex: index
    },
    destination,
    claimChannel,
    notificationEndpoint,
    claim,
    embeddedFields: {
      recipientId,
      ...(destinationId ? { destinationId, destinationReusable: !fiberInvoice } : {}),
      ...(claimId ? { claimId } : {}),
      ...(claimChannelId ? { claimChannelId } : {}),
      ...(notificationEndpointId ? { notificationEndpointId } : {})
    }
  };
}

async function upsertById(
  model: { updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, options: { upsert: true }): Promise<unknown> },
  idField: string,
  record?: Record<string, unknown>
): Promise<void> {
  if (!record) return;
  await model.updateOne({ [idField]: record[idField] }, { $setOnInsert: record }, { upsert: true });
}

export async function migrateRecipientIdentitySeparation(): Promise<void> {
  const now = new Date();
  const walletCursor = WalletModel.collection.find<Record<string, unknown>>({});
  for await (const wallet of walletCursor) {
    const walletId = optionalString(wallet.walletId);
    const address = optionalString(wallet.address);
    if (!walletId || !address) continue;
    await WalletPrincipalModel.updateOne(
      { walletId },
      {
        $setOnInsert: {
          principalId: legacyId('wpr', walletId),
          walletId,
          address,
          proofType: 'legacy_authenticated_wallet',
          verifiedAt: optionalDate(wallet.createdAt) ?? now
        }
      },
      { upsert: true }
    );
  }

  const sessionCursor = SessionModel.collection.find<Record<string, unknown>>({});
  for await (const session of sessionCursor) {
    const wallets = Array.isArray(session.recipientWallets) ? session.recipientWallets : [];
    for (const [index, value] of wallets.entries()) {
      if (!value || typeof value !== 'object') continue;
      const records = buildLegacySessionIdentityRecords(session, value as Record<string, unknown>, index, now);
      await upsertById(RecipientIdentityModel, 'recipientId', records.recipient);
      await upsertById(PaymentDestinationModel, 'destinationId', records.destination);
      await upsertById(ClaimChannelModel, 'channelId', records.claimChannel);
      await upsertById(NotificationEndpointModel, 'endpointId', records.notificationEndpoint);
      await upsertById(RecipientClaimModel, 'claimId', records.claim);
      const set = Object.fromEntries(
        Object.entries(records.embeddedFields).map(([field, fieldValue]) => ['recipientWallets.' + index + '.' + field, fieldValue])
      );
      await SessionModel.collection.updateOne({ _id: session._id as never }, { $set: set });
    }
  }

  const automationCursor = RecipientModel.collection.find<Record<string, unknown>>({});
  for await (const legacyRecipient of automationCursor) {
    const existingRecipientId = optionalString(legacyRecipient.recipientId);
    const ownerWalletId = optionalString(legacyRecipient.ownerWalletId);
    if (!existingRecipientId || !ownerWalletId) continue;
    await RecipientIdentityModel.updateOne(
      { recipientId: existingRecipientId },
      {
        $setOnInsert: {
          recipientId: existingRecipientId,
          ownerWalletId,
          name: optionalString(legacyRecipient.name) ?? 'Recipient',
          automationRecipientId: existingRecipientId
        }
      },
      { upsert: true }
    );
    const endpoint = optionalString(legacyRecipient.invoiceEndpoint);
    const address = optionalString(legacyRecipient.serviceAddress);
    const value = endpoint ?? address;
    if (!value) continue;
    const destinationId = legacyId('dst', 'automation:' + existingRecipientId);
    await PaymentDestinationModel.updateOne(
      { destinationId },
      {
        $setOnInsert: {
          destinationId,
          recipientId: existingRecipientId,
          ownerWalletId,
          rail: endpoint ? 'fiber' : 'ckb_onchain',
          network: env.FIBER_NETWORK,
          kind: endpoint ? 'endpoint' : 'address',
          value,
          valueHash: hashPrivateValue(value),
          reusable: true,
          status: legacyRecipient.status === 'disabled' ? 'revoked' : 'active',
          verificationMethod: 'legacy_import',
          verificationScope: 'delivery_instruction',
          verifiedAt: optionalDate(legacyRecipient.createdAt) ?? now,
          revokedAt: legacyRecipient.status === 'disabled' ? (optionalDate(legacyRecipient.disabledAt) ?? now) : undefined
        }
      },
      { upsert: true }
    );
  }
}
