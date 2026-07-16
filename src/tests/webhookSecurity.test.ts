import assert from 'node:assert/strict';
import { AppModel } from '../models/app.model.js';
import { WebhookDeliveryModel } from '../models/webhookDelivery.model.js';
import { webhookHttpFailure } from '../services/webhook.service.js';
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  isForbiddenWebhookAddress,
  resolveWebhookDestination,
  type WebhookDnsLookup
} from '../services/webhookSecurity.service.js';

const encryptionKey = '11'.repeat(32);
const encrypted = encryptWebhookSecret('fpwhsec_test_secret', encryptionKey);
assert.match(encrypted, /^v1\./);
assert.equal(encrypted.includes('fpwhsec_test_secret'), false);
assert.equal(decryptWebhookSecret(encrypted, encryptionKey), 'fpwhsec_test_secret');
assert.throws(() => decryptWebhookSecret(encrypted, '22'.repeat(32)), /could not be decrypted/);

for (const address of [
  '0.0.0.0',
  '10.1.2.3',
  '100.64.1.1',
  '127.0.0.1',
  '169.254.169.254',
  '172.16.0.1',
  '192.168.1.1',
  '224.0.0.1',
  '::',
  '::1',
  'fc00::1',
  'fe80::1',
  'ff02::1',
  '::ffff:127.0.0.1'
]) {
  assert.equal(isForbiddenWebhookAddress(address), true, address);
}
assert.equal(isForbiddenWebhookAddress('8.8.8.8'), false);
assert.equal(isForbiddenWebhookAddress('2606:4700:4700::1111'), false);

const publicLookup: WebhookDnsLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const destination = await resolveWebhookDestination('https://hooks.example.com/payments?source=fiberpass#ignored', publicLookup);
assert.equal(destination.url.toString(), 'https://hooks.example.com/payments?source=fiberpass');
assert.equal(destination.address, '93.184.216.34');

await assert.rejects(
  () => resolveWebhookDestination('http://hooks.example.com/callback', publicLookup),
  (error: unknown) => (error as { code?: string }).code === 'WEBHOOK_HTTPS_REQUIRED'
);
await assert.rejects(
  () => resolveWebhookDestination('https://hooks.example.com:8443/callback', publicLookup),
  (error: unknown) => (error as { code?: string }).code === 'WEBHOOK_PORT_FORBIDDEN'
);
await assert.rejects(
  () => resolveWebhookDestination('https://169.254.169.254/latest/meta-data'),
  (error: unknown) => (error as { code?: string }).code === 'WEBHOOK_DESTINATION_FORBIDDEN'
);
await assert.rejects(
  () => resolveWebhookDestination('https://hooks.example.com/callback', async () => [
    { address: '93.184.216.34', family: 4 },
    { address: '127.0.0.1', family: 4 }
  ]),
  (error: unknown) => (error as { code?: string }).code === 'WEBHOOK_DESTINATION_FORBIDDEN'
);

assert.equal(webhookHttpFailure(204), undefined);
assert.equal(webhookHttpFailure(302)?.code, 'WEBHOOK_REDIRECT_FORBIDDEN');
assert.equal(webhookHttpFailure(302)?.retryable, false);
assert.equal(webhookHttpFailure(400)?.retryable, false);
assert.equal(webhookHttpFailure(429)?.retryable, true);
assert.equal(webhookHttpFailure(503)?.retryable, true);

assert.ok(AppModel.schema.path('webhookSigningSecretEncrypted'));
assert.equal(AppModel.schema.path('webhookSigningSecret'), undefined);
assert.equal(WebhookDeliveryModel.schema.path('signingSecret'), undefined);
