import mongoose from 'mongoose';
import { env } from '../config/env.js';
import { MigrationModel } from '../models/migration.model.js';
import { migrations } from './index.js';

function duplicateKey(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: unknown }).code === 11000);
}

async function claimMigration(migrationId: string, description: string): Promise<boolean> {
  const existing = await MigrationModel.findOne({ migrationId }).lean();
  if (existing?.status === 'applied') return false;
  if (existing?.status === 'applying') {
    throw new Error('Migration is already applying: ' + migrationId);
  }
  if (existing?.status === 'failed') {
    await MigrationModel.updateOne(
      { migrationId, status: 'failed' },
      { $set: { status: 'applying', description, startedAt: new Date() }, $unset: { failedAt: 1, failureMessage: 1 } }
    );
    return true;
  }
  try {
    await MigrationModel.create({ migrationId, description, status: 'applying', startedAt: new Date() });
    return true;
  } catch (error) {
    if (duplicateKey(error)) throw new Error('Migration was claimed by another process: ' + migrationId);
    throw error;
  }
}

async function run(): Promise<void> {
  await mongoose.connect(env.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 10_000 });
  await MigrationModel.createIndexes();

  for (const migration of migrations) {
    if (!await claimMigration(migration.id, migration.description)) {
      console.log('skip ' + migration.id);
      continue;
    }
    console.log('apply ' + migration.id);
    try {
      await migration.up();
      await MigrationModel.updateOne(
        { migrationId: migration.id, status: 'applying' },
        { $set: { status: 'applied', appliedAt: new Date() } }
      );
      console.log('applied ' + migration.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown migration failure';
      await MigrationModel.updateOne(
        { migrationId: migration.id },
        { $set: { status: 'failed', failedAt: new Date(), failureMessage: message } }
      );
      throw error;
    }
  }
}

run()
  .then(() => mongoose.disconnect())
  .catch(async (error) => {
    console.error(error);
    await mongoose.disconnect().catch(() => undefined);
    process.exit(1);
  });
