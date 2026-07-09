import assert from 'node:assert/strict';
import { FIBER_CKB_ADDRESS_ERROR, isFiberCkbAddress } from '../lib/fiberAddress.js';

const ckbTestnetAddress = 'ckt1qrfrwcdnvssswdwpn3s9v8fp87emat306ctjwsm3nmlkjg8qyza2cqgqqxlert9yy2g2hhklyq8m24sakhfaqlyf4qd4c3fl';
const ckbMainnetAddress = 'ckb' + ckbTestnetAddress.slice(3);

assert.equal(isFiberCkbAddress(ckbTestnetAddress), true);
assert.equal(isFiberCkbAddress(ckbMainnetAddress), true);
assert.equal(isFiberCkbAddress('  ' + ckbTestnetAddress + '  '), true);
assert.equal(isFiberCkbAddress('0x71C7656EC7ab88b098defB751B7401B5f6d14766'), false);
assert.equal(isFiberCkbAddress('app.eth'), false);
assert.equal(isFiberCkbAddress('ckt1invalidaddress'), false);
assert.match(FIBER_CKB_ADDRESS_ERROR, /CKB address/);
