import { Schema, model, type InferSchemaType } from 'mongoose';

export const WEBHOOK_DELIVERY_STATUSES = ['queued', 'delivering', 'succeeded', 'retrying', 'failed', 'cancelled'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

const webhookDeliverySchema = new Schema(
  {
    deliveryId: { type: String, required: true, unique: true, index: true },
    ownerWalletId: { type: String, required: true, index: true },
    appId: { type: String, required: true, index: true },
    eventType: { type: String, required: true, trim: true, index: true },
    targetType: { type: String, required: true, trim: true },
    targetId: { type: String, required: true, trim: true, index: true },
    url: { type: String, required: true, trim: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: WEBHOOK_DELIVERY_STATUSES, required: true, default: 'queued', index: true },
    attempts: { type: Number, required: true, min: 0, default: 0 },
    maxAttempts: { type: Number, required: true, min: 1, default: 5 },
    runAfter: { type: Date, required: true, default: Date.now, index: true },
    lockedAt: { type: Date, index: true },
    lockedBy: { type: String, trim: true, index: true },
    deliveredAt: { type: Date },
    failedAt: { type: Date },
    responseStatus: { type: Number },
    lastFailureCode: { type: String, trim: true },
    lastFailureMessage: { type: String, trim: true }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

webhookDeliverySchema.index({ status: 1, runAfter: 1, createdAt: 1 });
webhookDeliverySchema.index({ appId: 1, eventType: 1, createdAt: -1 });
webhookDeliverySchema.index({ ownerWalletId: 1, appId: 1, createdAt: -1 });

export type WebhookDeliveryRecord = InferSchemaType<typeof webhookDeliverySchema>;
export const WebhookDeliveryModel = model('WebhookDelivery', webhookDeliverySchema);
