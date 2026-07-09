const FIBER_CKB_ADDRESS_PATTERN = /^(ckb|ckt)1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38,180}$/i;

export const FIBER_CKB_ADDRESS_ERROR = 'Enter a valid Fiber Network CKB address (ckt1... or ckb1...).';

export function isFiberCkbAddress(value: string): boolean {
  const address = value.trim();
  return FIBER_CKB_ADDRESS_PATTERN.test(address);
}
