import assert from 'node:assert/strict';
import fc from 'fast-check';
import {
  MAX_ATOMIC_VALUE,
  addAtomicAmounts,
  asAtomicAmount,
  atomicAmountFromBigInt,
  atomicAmountToLegacySafeNumber,
  capAtomicAmount,
  formatAtomicAmount,
  majorToAtomicAmount,
  parseAtomicAmount,
  subtractAtomicAmounts
} from '../lib/money.js';

const aboveSafeMillisatoshis = asAtomicAmount('9007199254740993');
assert.equal(parseAtomicAmount(aboveSafeMillisatoshis), 9007199254740993n);
assert.equal(JSON.parse(JSON.stringify({ amountAtomic: aboveSafeMillisatoshis })).amountAtomic, '9007199254740993');
assert.throws(() => atomicAmountToLegacySafeNumber(aboveSafeMillisatoshis), /legacy numeric contract/);

for (const invalid of ['', ' ', '-1', '+1', '01', '1.0', '1e3', '0x10', '10 ']) {
  assert.throws(() => parseAtomicAmount(invalid), /Atomic amount/);
}
for (const invalid of [1, 1.5, -1, Number.MAX_SAFE_INTEGER + 1, null, undefined]) {
  assert.throws(() => parseAtomicAmount(invalid), /Atomic amount/);
}
assert.throws(() => atomicAmountFromBigInt(MAX_ATOMIC_VALUE + 1n), /256-bit/);
assert.throws(() => subtractAtomicAmounts(asAtomicAmount('1'), asAtomicAmount('2')), /non-negative/);
assert.equal(majorToAtomicAmount('0.00000000001', 'BTC'), '1');
assert.throws(() => majorToAtomicAmount(Number.MAX_SAFE_INTEGER + 1, 'CKB'), /safe integer/);
assert.equal(formatAtomicAmount(asAtomicAmount('123400000000'), 11), '1.23400000000');
assert.equal(formatAtomicAmount(asAtomicAmount('123400000000'), 11, { trimTrailingZeros: true }), '1.234');

fc.assert(fc.property(fc.bigInt({ min: 0n, max: MAX_ATOMIC_VALUE }), (value) => {
  const atomic = atomicAmountFromBigInt(value);
  assert.equal(parseAtomicAmount(atomic), value);
  assert.equal(asAtomicAmount(JSON.parse(JSON.stringify(atomic))), atomic);
}));

fc.assert(fc.property(
  fc.bigInt({ min: 0n, max: 10n ** 40n }),
  fc.integer({ min: 0, max: 18 }),
  (value, decimals) => {
    const formatted = formatAtomicAmount(atomicAmountFromBigInt(value), decimals);
    if (decimals === 0) {
      assert.equal(BigInt(formatted), value);
      return;
    }
    const [whole, fraction = ''] = formatted.split('.');
    const reconstructed = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
    assert.equal(reconstructed, value);
  }
));

const halfRange = MAX_ATOMIC_VALUE / 2n;
fc.assert(fc.property(
  fc.bigInt({ min: 0n, max: halfRange }),
  fc.bigInt({ min: 0n, max: halfRange }),
  (left, right) => {
    assert.equal(
      parseAtomicAmount(addAtomicAmounts(atomicAmountFromBigInt(left), atomicAmountFromBigInt(right))),
      left + right
    );
  }
));

fc.assert(fc.property(
  fc.bigInt({ min: 0n, max: halfRange }),
  fc.bigInt({ min: 0n, max: halfRange }),
  (left, right) => {
    const high = left >= right ? left : right;
    const low = left >= right ? right : left;
    assert.equal(
      parseAtomicAmount(subtractAtomicAmounts(atomicAmountFromBigInt(high), atomicAmountFromBigInt(low))),
      high - low
    );
  }
));

fc.assert(fc.property(
  fc.bigInt({ min: 0n, max: halfRange }),
  fc.bigInt({ min: 0n, max: halfRange }),
  (value, maximum) => {
    assert.equal(
      parseAtomicAmount(capAtomicAmount(atomicAmountFromBigInt(value), atomicAmountFromBigInt(maximum))),
      value <= maximum ? value : maximum
    );
  }
));
