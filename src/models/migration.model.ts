import { Schema, model, type InferSchemaType } from 'mongoose';

const migrationSchema = new Schema(
  {
    migrationId: { type: String, required: true, unique: true, index: true },
    description: { type: String, required: true, trim: true },
    status: { type: String, enum: ['applying', 'applied', 'failed'], required: true, index: true },
    startedAt: { type: Date, required: true },
    appliedAt: { type: Date },
    failedAt: { type: Date },
    failureMessage: { type: String, trim: true }
  },
  { timestamps: true, versionKey: false }
);

export type MigrationRecord = InferSchemaType<typeof migrationSchema>;
export const MigrationModel = model('Migration', migrationSchema);
