export const ATOMIC_AMOUNT_PATTERN = /^(0|[1-9]\d*)$/;
export const ASSET_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}:[a-z0-9][a-z0-9._:-]{0,127}$/;

export function atomicAmountField(options: { required?: boolean; default?: string } = {}) {
  return {
    type: String,
    required: options.required ?? false,
    ...(options.default == null ? {} : { default: options.default }),
    minlength: 1,
    maxlength: 78,
    match: ATOMIC_AMOUNT_PATTERN
  };
}

export function assetIdField() {
  return { type: String, required: true, default: 'ckb:ckb', match: ASSET_ID_PATTERN };
}

export function moneyContractVersionField() {
  return { type: Number, required: true, default: 2, enum: [2] };
}
