import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { env } from '../config/env.js';
import { isReusableDestinationKind, type DestinationKind } from '../domain/identity.js';
import { ChargeAttemptModel } from '../models/chargeAttempt.model.js';
import {
  ClaimChannelModel,
  NotificationEndpointModel,
  PaymentDestinationModel,
  RecipientClaimModel,
  RecipientIdentityModel,
  WalletPrincipalModel
} from '../models/identity.model.js';
import { SessionModel } from '../models/session.model.js';

export interface RecipientIdentityProjection {
  recipientId: string;
  destinationId?: string;
  destinationReusable?: boolean;
  claimId?: string;
  claimChannelId?: string;
  notificationEndpointId?: string;
  name: string;
  address?: string;
  email?: string;
  fiberInvoice?: string;
  inviteTokenHash?: string;
  inviteTokenExpiresAt?: string | Date;
  inviteClaimedAt?: string | Date;
  inviteStatus?: string;
}

export function hashPrivateValue(value: string): string {
  return createHash('sha256').update(value.trim()).digest('hex');
}

export function hashContactValue(value: string): string {
  return hashPrivateValue(value.trim().toLowerCase());
}

export function newIdentityId(prefix: string): string {
  return prefix + '_' + randomUUID();
}

export function destinationProjection(input: { address?: string; fiberInvoice?: string }): {
  rail: 'ckb_onchain' | 'fiber';
  kind: DestinationKind;
  value: string;
  reusable: boolean;
} | null {
  if (input.address) return { rail: 'ckb_onchain', kind: 'address', value: input.address, reusable: true };
  if (input.fiberInvoice) return { rail: 'fiber', kind: 'invoice', value: input.fiberInvoice, reusable: false };
  return null;
}

export function withRecipientIdentityIds<T extends Omit<RecipientIdentityProjection, 'recipientId'>>(wallet: T): T & RecipientIdentityProjection {
  const destination = destinationProjection(wallet);
  return {
    ...wallet,
    recipientId: newIdentityId('rcp'),
    ...(destination ? {
      destinationId: newIdentityId('dst'),
      destinationReusable: isReusableDestinationKind(destination.kind)
    } : {}),
    ...(wallet.email ? {
      claimChannelId: newIdentityId('chn'),
      notificationEndpointId: newIdentityId('ntf')
    } : {})
  };
}

export async function persistSessionRecipientIdentities(input: {
  ownerWalletId: string;
  ownerAddress: string;
  sessionId: string;
  wallets: RecipientIdentityProjection[];
  session: ClientSession;
}): Promise<void> {
  const now = new Date();
  const principalId = 'wpr_' + hashPrivateValue(input.ownerWalletId);
  await WalletPrincipalModel.updateOne(
    { walletId: input.ownerWalletId },
    {
      $setOnInsert: {
        principalId,
        walletId: input.ownerWalletId,
        address: input.ownerAddress,
        proofType: 'wallet_signature',
        verifiedAt: now
      }
    },
    { upsert: true, session: input.session }
  );

  if (input.wallets.length === 0) return;
  await RecipientIdentityModel.create(input.wallets.map((wallet, index) => ({
    recipientId: wallet.recipientId,
    ownerWalletId: input.ownerWalletId,
    name: wallet.name,
    sessionId: input.sessionId,
    sessionRecipientIndex: index
  })), { session: input.session });

  const destinations = input.wallets.flatMap((wallet) => {
    const projection = destinationProjection(wallet);
    if (!projection || !wallet.destinationId) return [];
    return [{
      destinationId: wallet.destinationId,
      recipientId: wallet.recipientId,
      ownerWalletId: input.ownerWalletId,
      ...projection,
      network: env.FIBER_NETWORK,
      valueHash: hashPrivateValue(projection.value),
      status: 'active',
      verificationMethod: 'owner_configured',
      verificationScope: 'delivery_instruction',
      verifiedAt: now
    }];
  });
  if (destinations.length > 0) await PaymentDestinationModel.create(destinations, { session: input.session });

  const channels = input.wallets.flatMap((wallet) => wallet.email && wallet.claimChannelId ? [{
    channelId: wallet.claimChannelId,
    recipientId: wallet.recipientId,
    ownerWalletId: input.ownerWalletId,
    type: 'email',
    value: wallet.email,
    valueHash: hashContactValue(wallet.email),
    status: 'active'
  }] : []);
  if (channels.length > 0) await ClaimChannelModel.create(channels, { session: input.session });

  const endpoints = input.wallets.flatMap((wallet) => wallet.email && wallet.notificationEndpointId ? [{
    endpointId: wallet.notificationEndpointId,
    recipientId: wallet.recipientId,
    ownerWalletId: input.ownerWalletId,
    type: 'email',
    purpose: 'receipt',
    value: wallet.email,
    valueHash: hashContactValue(wallet.email),
    status: 'active'
  }] : []);
  if (endpoints.length > 0) await NotificationEndpointModel.create(endpoints, { session: input.session });

  const claims = input.wallets.flatMap((wallet, index) => (
    wallet.claimId && wallet.inviteTokenHash && wallet.inviteTokenExpiresAt
      ? [{
          claimId: wallet.claimId,
          recipientId: wallet.recipientId,
          ownerWalletId: input.ownerWalletId,
          sessionId: input.sessionId,
          sessionRecipientIndex: index,
          channelId: wallet.claimChannelId,
          tokenHash: wallet.inviteTokenHash,
          purpose: 'bind_destination',
          status: 'pending',
          expiresAt: new Date(wallet.inviteTokenExpiresAt)
        }]
      : []
  ));
  if (claims.length > 0) await RecipientClaimModel.create(claims, { session: input.session });
}

export async function syncAutomationRecipientIdentity(input: {
  recipientId: string;
  ownerWalletId: string;
  name: string;
  serviceAddress: string;
  invoiceEndpoint?: string | null;
  status: 'active' | 'disabled';
  disabledAt?: Date | null;
  session: ClientSession;
}): Promise<void> {
  const now = new Date();
  await RecipientIdentityModel.updateOne(
    { recipientId: input.recipientId },
    {
      $set: {
        ownerWalletId: input.ownerWalletId,
        name: input.name,
        automationRecipientId: input.recipientId
      },
      $setOnInsert: { recipientId: input.recipientId }
    },
    { upsert: true, session: input.session }
  );
  if (input.status === 'disabled') {
    await PaymentDestinationModel.updateMany(
      { recipientId: input.recipientId, status: 'active' },
      { $set: { status: 'revoked', revokedAt: input.disabledAt ?? now } },
      { session: input.session }
    );
    return;
  }

  const endpoint = input.invoiceEndpoint?.trim();
  const destination = endpoint
    ? { rail: 'fiber' as const, kind: 'endpoint' as const, value: endpoint, reusable: true }
    : { rail: 'ckb_onchain' as const, kind: 'address' as const, value: input.serviceAddress.trim(), reusable: true };
  const valueHash = hashPrivateValue(destination.value);
  const current = await PaymentDestinationModel.findOne({
    recipientId: input.recipientId,
    status: 'active'
  }).session(input.session).lean();
  if (current && current.kind === destination.kind && current.valueHash === valueHash) return;

  const destinationId = newIdentityId('dst');
  await PaymentDestinationModel.updateMany(
    { recipientId: input.recipientId, status: 'active' },
    { $set: { status: 'replaced', replacedAt: now, replacedByDestinationId: destinationId } },
    { session: input.session }
  );
  await PaymentDestinationModel.create([{
    destinationId,
    recipientId: input.recipientId,
    ownerWalletId: input.ownerWalletId,
    ...destination,
    network: env.FIBER_NETWORK,
    valueHash,
    status: 'active',
    verificationMethod: 'owner_configured',
    verificationScope: 'delivery_instruction',
    verifiedAt: now
  }], { session: input.session });
}

export interface ContactDataExport {
  recipients: Array<{
    recipientId: string;
    name: string;
    claimChannels: Array<{ channelId: string; type: string; value?: string; status: string }>;
    notificationEndpoints: Array<{ endpointId: string; type: string; purpose: string; value?: string; status: string }>;
  }>;
  immutablePaymentProofs: Array<{
    attemptId: string;
    sessionId: string;
    status: string;
    proofId?: string;
    providerCorrelationId?: string;
  }>;
}

export async function exportContactData(ownerWalletId: string): Promise<ContactDataExport> {
  const [recipients, channels, endpoints, attempts] = await Promise.all([
    RecipientIdentityModel.find({ ownerWalletId }).sort({ createdAt: 1 }).lean(),
    ClaimChannelModel.find({ ownerWalletId }).sort({ createdAt: 1 }).lean(),
    NotificationEndpointModel.find({ ownerWalletId }).sort({ createdAt: 1 }).lean(),
    ChargeAttemptModel.find({ ownerWalletId }).sort({ createdAt: 1 }).lean()
  ]);
  return {
    recipients: recipients.map((recipient) => ({
      recipientId: recipient.recipientId,
      name: recipient.name,
      claimChannels: channels.filter((channel) => channel.recipientId === recipient.recipientId).map((channel) => ({
        channelId: channel.channelId,
        type: channel.type,
        value: channel.value ?? undefined,
        status: channel.status
      })),
      notificationEndpoints: endpoints.filter((endpoint) => endpoint.recipientId === recipient.recipientId).map((endpoint) => ({
        endpointId: endpoint.endpointId,
        type: endpoint.type,
        purpose: endpoint.purpose,
        value: endpoint.value ?? undefined,
        status: endpoint.status
      }))
    })),
    immutablePaymentProofs: attempts.map((attempt) => ({
      attemptId: attempt.attemptId,
      sessionId: attempt.sessionId,
      status: attempt.status,
      proofId: attempt.proofId ?? undefined,
      providerCorrelationId: attempt.providerCorrelationId ?? undefined
    }))
  };
}

export async function deleteContactData(ownerWalletId: string): Promise<{
  claimChannelsDeleted: number;
  notificationEndpointsDeleted: number;
  claimsRevoked: number;
  paymentProofsPreserved: number;
}> {
  const now = new Date();
  const [channelResult, endpointResult, claimResult, proofCount] = await Promise.all([
    ClaimChannelModel.updateMany(
      { ownerWalletId, status: { $ne: 'deleted' } },
      { $set: { status: 'deleted', deletedAt: now }, $unset: { value: 1, valueHash: 1 } }
    ),
    NotificationEndpointModel.updateMany(
      { ownerWalletId, status: { $ne: 'deleted' } },
      { $set: { status: 'deleted', deletedAt: now }, $unset: { value: 1, valueHash: 1 } }
    ),
    RecipientClaimModel.updateMany(
      { ownerWalletId, status: 'pending' },
      { $set: { status: 'revoked', revokedAt: now } }
    ),
    ChargeAttemptModel.countDocuments({ ownerWalletId })
  ]);
  await Promise.all([
    RecipientIdentityModel.updateMany({ ownerWalletId }, { $set: { contactDeletedAt: now } }),
    SessionModel.updateMany(
      { ownerWalletId },
      {
        $unset: {
          'recipientWallets.$[].email': 1,
          'recipientWallets.$[].recipientTimeZone': 1,
          'recipientWallets.$[].inviteTokenHash': 1,
          'recipientWallets.$[].inviteTokenExpiresAt': 1,
          'recipientWallets.$[].inviteSentAt': 1,
          'recipientWallets.$[].inviteLastFailure': 1,
          'recipientWallets.$[].claimChannelId': 1,
          'recipientWallets.$[].notificationEndpointId': 1
        }
      }
    )
  ]);
  return {
    claimChannelsDeleted: channelResult.modifiedCount,
    notificationEndpointsDeleted: endpointResult.modifiedCount,
    claimsRevoked: claimResult.modifiedCount,
    paymentProofsPreserved: proofCount
  };
}
