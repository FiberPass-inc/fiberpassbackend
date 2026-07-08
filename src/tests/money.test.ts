import assert from 'node:assert/strict';
import { fallbackMinorUnits, fromMinorUnits, toMinorUnits } from '../lib/money.js';

assert.equal(toMinorUnits('0.02'), 20_000);
assert.equal(toMinorUnits('1240.50'), 1_240_500_000);
assert.equal(fromMinorUnits(20_000), 0.02);
assert.equal(fallbackMinorUnits(undefined, 0.005), 5_000);
assert.throws(() => toMinorUnits('0.0000001'), /at most 6 decimal/);
