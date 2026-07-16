import { Schema, model, type InferSchemaType } from 'mongoose';

const workerLeaseSchema = new Schema(
  {
    leaseKey: { type: String, required: true, unique: true, index: true },
    ownerId: { type: String, required: true, index: true },
    acquiredAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true, index: true }
  },
  { timestamps: true, versionKey: false }
);

export type WorkerLeaseRecord = InferSchemaType<typeof workerLeaseSchema>;
export const WorkerLeaseModel = model('WorkerLease', workerLeaseSchema);
