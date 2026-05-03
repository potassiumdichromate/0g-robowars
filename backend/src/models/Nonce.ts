import mongoose, { Document, Schema } from 'mongoose';

export interface INonce extends Document {
  walletAddress: string;
  nonce: string;          // UUID v4 — single-use
  expiresAt: Date;
  used: boolean;
}

const NonceSchema = new Schema<INonce>(
  {
    walletAddress: {
      type: String,
      required: true,
      lowercase: true,
      index: true,
    },
    nonce: {
      type: String,
      required: true,
      unique: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      // TTL index: MongoDB auto-deletes expired documents
      index: { expireAfterSeconds: 0 },
    },
    used: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true, collection: 'nonces' }
);

export const Nonce = mongoose.model<INonce>('Nonce', NonceSchema);
