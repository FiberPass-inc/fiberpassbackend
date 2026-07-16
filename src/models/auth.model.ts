import { Schema, model, type InferSchemaType } from 'mongoose';

const authChallengeSchema = new Schema(
  {
    challengeId: { type: String, required: true, unique: true, index: true },
    address: { type: String, trim: true },
    message: { type: String, required: true },
    nonce: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

authChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 300 });

const authSessionSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true, index: true },
    walletId: { type: String, required: true, index: true },
    address: { type: String, required: true },
    expiresAt: { type: Date, required: true }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

authSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

export type AuthChallengeRecord = InferSchemaType<typeof authChallengeSchema>;
export type AuthSessionRecord = InferSchemaType<typeof authSessionSchema>;

export const AuthChallengeModel = model('AuthChallenge', authChallengeSchema);
export const AuthSessionModel = model('AuthSession', authSessionSchema);
