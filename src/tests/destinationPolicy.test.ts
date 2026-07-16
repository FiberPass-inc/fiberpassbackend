import assert from 'node:assert/strict';

process.env.FIBER_NETWORK = 'testnet';

const { validateRecipientDestination } = await import('../services/session.service.js');

const walletAddress = 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl';
const accepted = await validateRecipientDestination({ amount: 100, currency: 'CKB', address: walletAddress });
assert.equal(accepted.mode, 'ckb');
assert.ok(accepted.minimumAmount > 0);
assert.ok(accepted.minimumAmountMinor > 0);

await assert.rejects(
  () => validateRecipientDestination({ amount: 0.01, currency: 'CKB', address: walletAddress }),
  (error: unknown) => (
    (error as { code?: string }).code === 'CKB_RECIPIENT_AMOUNT_BELOW_MINIMUM'
    && typeof (error as { details?: { minimumAmountMinor?: unknown } }).details?.minimumAmountMinor === 'number'
  )
);

await assert.rejects(
  () => validateRecipientDestination({ amount: 100, currency: 'CKB', address: walletAddress, fiberInvoice: 'fibt-conflicting-invoice' }),
  (error: unknown) => (error as { code?: string }).code === 'RECIPIENT_DESTINATION_CONFLICT'
);
