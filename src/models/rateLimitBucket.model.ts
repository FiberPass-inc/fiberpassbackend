import { Schema, model, type InferSchemaType } from 'mongoose';

const rateLimitBucketSchema = new Schema(
  {
    bucketKey: { type: String, required: true, unique: true, index: true },
    count: { type: Number, required: true, min: 0 },
    expiresAt: { type: Date, required: true }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

rateLimitBucketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RateLimitBucketRecord = InferSchemaType<typeof rateLimitBucketSchema>;
export const RateLimitBucketModel = model('RateLimitBucket', rateLimitBucketSchema);
