import { hostname } from 'node:os';
import { WorkerHeartbeatModel, WORKER_KINDS, type WorkerKind } from '../models/workerHeartbeat.model.js';
import { WorkerLeaseModel } from '../models/workerLease.model.js';

export interface WorkerReadinessDto {
  ready: boolean;
  staleAfterMs: number;
  workers: Array<{
    kind: WorkerKind;
    ready: boolean;
    instances: number;
    freshInstances: number;
    lastSeenAt?: string;
  }>;
}

function isDuplicateKeyError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 11000);
}

export async function recordWorkerHeartbeat(input: {
  workerId: string;
  kind: WorkerKind;
  status?: 'running' | 'degraded' | 'stopping';
  success?: boolean;
  errorCode?: string;
  metrics?: Record<string, unknown>;
  startedAt?: Date;
}): Promise<void> {
  const now = new Date();
  await WorkerHeartbeatModel.updateOne(
    { workerId: input.workerId },
    {
      $set: {
        kind: input.kind,
        status: input.status ?? (input.errorCode ? 'degraded' : 'running'),
        lastSeenAt: now,
        metrics: input.metrics ?? {},
        pid: process.pid,
        hostname: hostname(),
        ...(input.success ? { lastSuccessAt: now } : {}),
        ...(input.errorCode ? { lastErrorAt: now, lastErrorCode: input.errorCode } : {})
      },
      $setOnInsert: { startedAt: input.startedAt ?? now }
    },
    { upsert: true }
  );
}

export async function getWorkerReadiness(staleAfterMs = 30_000): Promise<WorkerReadinessDto> {
  const safeStaleAfterMs = Math.max(5_000, staleAfterMs);
  const staleBefore = new Date(Date.now() - safeStaleAfterMs);
  const records = await WorkerHeartbeatModel.find({ kind: { $in: WORKER_KINDS } })
    .select('kind status lastSeenAt')
    .lean<Array<{ kind: WorkerKind; status: string; lastSeenAt: Date }>>();
  const workers = WORKER_KINDS.map((kind) => {
    const instances = records.filter((record) => record.kind === kind);
    const fresh = instances.filter((record) => record.status !== 'stopping' && record.lastSeenAt > staleBefore);
    const latest = instances.sort((left, right) => right.lastSeenAt.getTime() - left.lastSeenAt.getTime())[0];
    return {
      kind,
      ready: fresh.length > 0,
      instances: instances.length,
      freshInstances: fresh.length,
      lastSeenAt: latest?.lastSeenAt.toISOString()
    };
  });
  return { ready: workers.every((worker) => worker.ready), staleAfterMs: safeStaleAfterMs, workers };
}

export async function acquireWorkerLease(input: {
  leaseKey: string;
  ownerId: string;
  ttlMs: number;
  now?: Date;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  try {
    const lease = await WorkerLeaseModel.findOneAndUpdate(
      {
        leaseKey: input.leaseKey,
        $or: [
          { ownerId: input.ownerId },
          { expiresAt: { $lte: now } }
        ]
      },
      {
        $set: {
          ownerId: input.ownerId,
          acquiredAt: now,
          expiresAt: new Date(now.getTime() + Math.max(1_000, input.ttlMs))
        }
      },
      { new: true, upsert: true }
    ).lean();
    return lease?.ownerId === input.ownerId;
  } catch (error) {
    if (isDuplicateKeyError(error)) return false;
    throw error;
  }
}

export async function releaseWorkerLease(leaseKey: string, ownerId: string): Promise<void> {
  await WorkerLeaseModel.updateOne(
    { leaseKey, ownerId },
    { $set: { expiresAt: new Date(0) } }
  );
}
