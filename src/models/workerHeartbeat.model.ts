import { Schema, model, type InferSchemaType } from 'mongoose';

export const WORKER_KINDS = ['payments', 'reconciliation', 'webhooks'] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

const workerHeartbeatSchema = new Schema(
  {
    workerId: { type: String, required: true, unique: true, index: true },
    kind: { type: String, enum: WORKER_KINDS, required: true, index: true },
    status: { type: String, enum: ['running', 'degraded', 'stopping'], required: true, default: 'running', index: true },
    startedAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true, index: true },
    lastSuccessAt: { type: Date },
    lastErrorAt: { type: Date },
    lastErrorCode: { type: String, trim: true },
    metrics: { type: Schema.Types.Mixed, default: {} },
    pid: { type: Number },
    hostname: { type: String, trim: true }
  },
  { timestamps: true, versionKey: false }
);

workerHeartbeatSchema.index({ kind: 1, lastSeenAt: -1 });

export type WorkerHeartbeatRecord = InferSchemaType<typeof workerHeartbeatSchema>;
export const WorkerHeartbeatModel = model('WorkerHeartbeat', workerHeartbeatSchema);
