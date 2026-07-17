import assert from 'node:assert/strict';
import { isReusableDestinationKind, paymentPurposeRepeats } from '../domain/identity.js';
import { buildLegacySessionIdentityRecords } from '../migrations/identitySeparation.js';
import { ClaimChannelModel, PaymentDestinationModel, RecipientClaimModel } from '../models/identity.model.js';
import { destinationProjection, hashContactValue, hashPrivateValue } from '../services/recipientIdentity.service.js';

const now = new Date('2026-07-17T12:00:00.000Z');
const active = buildLegacySessionIdentityRecords(
  { publicId: 'legacy-pass', ownerWalletId: 'payer-wallet', paymentPurpose: 'scheduled_release', createdAt: new Date('2026-01-01') },
  {
    name: 'Email recipient',
    email: 'Recipient@Example.com',
    address: 'ckt1-recipient',
    inviteTokenHash: 'hashed-token-only',
    inviteTokenExpiresAt: new Date('2026-07-18T12:00:00.000Z')
  },
  0,
  now
);

assert.equal(active.recipient.name, 'Email recipient');
assert.equal(active.destination?.kind, 'address');
assert.equal(active.destination?.reusable, true);
assert.equal(active.destination?.verificationScope, 'delivery_instruction');
assert.equal(active.claimChannel?.value, 'recipient@example.com');
assert.equal(active.notificationEndpoint?.purpose, 'receipt');
assert.equal(active.claim?.tokenHash, 'hashed-token-only');
assert.equal(active.claim?.status, 'pending');
assert.notEqual(active.embeddedFields.recipientId, active.embeddedFields.destinationId);

const expired = buildLegacySessionIdentityRecords(
  { publicId: 'legacy-expired', ownerWalletId: 'payer-wallet' },
  {
    name: 'Expired recipient',
    email: 'expired@example.com',
    fiberInvoice: 'fiber-one-time-payment-request',
    inviteTokenHash: 'expired-token-hash',
    inviteTokenExpiresAt: new Date('2026-07-16T12:00:00.000Z')
  },
  0,
  now
);
assert.equal(expired.destination?.kind, 'invoice');
assert.equal(expired.destination?.reusable, false);
assert.equal(expired.claim?.status, 'expired');

assert.deepEqual(destinationProjection({ address: 'ckt1-recipient' }), {
  rail: 'ckb_onchain',
  kind: 'address',
  value: 'ckt1-recipient',
  reusable: true
});
assert.equal(destinationProjection({ fiberInvoice: 'invoice' })?.reusable, false);
assert.equal(isReusableDestinationKind('endpoint'), true);
assert.equal(isReusableDestinationKind('invoice'), false);
assert.equal(paymentPurposeRepeats('subscription'), true);
assert.equal(paymentPurposeRepeats('scheduled_release'), false);
assert.equal(hashContactValue('Recipient@Example.com'), hashContactValue(' recipient@example.com '));
assert.notEqual(hashPrivateValue('https://example.com/Path'), hashPrivateValue('https://example.com/path'));

const claimIndexes = RecipientClaimModel.schema.indexes().map(([fields]) => fields);
assert.ok(claimIndexes.some((fields) => fields.tokenHash === 1));
const destinationIndexes = PaymentDestinationModel.schema.indexes().map(([fields]) => fields);
assert.ok(destinationIndexes.some((fields) => fields.recipientId === 1 && fields.status === 1));
assert.notEqual(ClaimChannelModel.schema.path('value').isRequired, true);
