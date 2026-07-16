import { Schema, model, type InferSchemaType } from 'mongoose';

const streamTicketSchema = new Schema(
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

streamTicketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type StreamTicketRecord = InferSchemaType<typeof streamTicketSchema>;
export const StreamTicketModel = model('StreamTicket', streamTicketSchema);
