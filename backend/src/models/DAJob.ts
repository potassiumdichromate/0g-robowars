/**
 * DAJob — MongoDB document representing a single pending DA commitment job.
 *
 * Why this exists:
 *   setImmediate fires the DA pipeline in-process. If the server crashes,
 *   OOMs, or restarts mid-flight, the job is silently lost — the save has
 *   no DA commitment, and that player can never submit to the leaderboard.
 *
 *   Persisting the job here means restarts are safe. The DAQueue worker
 *   picks up pending/stale jobs on every boot and on every poll cycle.
 *
 * Retry strategy: exponential backoff capped at 30 minutes.
 *   attempt 1 →  30s
 *   attempt 2 →  60s
 *   attempt 3 → 120s
 *   attempt 4 → 240s
 *   attempt 5 → 480s (then → failed)
 */

import mongoose, { Document, Schema } from 'mongoose';

export type DAJobStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface IDAJob extends Document {
  saveId: mongoose.Types.ObjectId;
  rootHash: string;
  walletAddress: string;
  status: DAJobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextRetryAt: Date;
  processingStartedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const DAJobSchema = new Schema<IDAJob>(
  {
    saveId: {
      type: Schema.Types.ObjectId,
      ref: 'Save',
      required: true,
      index: true,
    },
    rootHash: { type: String, required: true },
    walletAddress: { type: String, required: true, lowercase: true },
    status: {
      type: String,
      enum: ['pending', 'processing', 'done', 'failed'],
      default: 'pending',
    },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    lastError: { type: String, default: null },
    nextRetryAt: { type: Date, default: () => new Date() },
    // Used to detect stale 'processing' jobs after a crash
    processingStartedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Worker poll query: status=pending, due now, ordered by creation time
DAJobSchema.index({ status: 1, nextRetryAt: 1 });

// Done/failed jobs are queryable by saveId for diagnostics
DAJobSchema.index({ saveId: 1 });

export const DAJob = mongoose.model<IDAJob>('DAJob', DAJobSchema);
