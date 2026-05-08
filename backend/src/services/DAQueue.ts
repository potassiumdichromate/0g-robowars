/**
 * DAQueue — durable, crash-safe queue for 0G DA commitment publishing.
 *
 * ── Why not setImmediate? ───────────────────────────────────────────────────────
 *
 * setImmediate fires the DA pipeline entirely in-process:
 *
 *   POST /save/upload → response sent → setImmediate fires DA job
 *
 * If the Node process dies between "response sent" and "DA finalized", the job
 * is gone. The save document stays permanently at daStatus='pending'. That
 * player can never submit to the leaderboard because the DA layer never commits.
 * There is no recovery path — the operator has to manually re-trigger DA for
 * every affected save, which is operationally impossible at scale.
 *
 * ── This queue ─────────────────────────────────────────────────────────────────
 *
 * Jobs are persisted in MongoDB before the HTTP response is sent.
 * If the server restarts at any point — before, during, or after a job — the
 * worker picks it up on the next poll cycle.
 *
 * ── Multi-replica safety ───────────────────────────────────────────────────────
 *
 * Jobs are claimed atomically using findOneAndUpdate with `$set: { status: 'processing' }`.
 * MongoDB's document-level atomicity guarantees only one replica claims any job.
 *
 * To guard against crashes mid-processing (the worker claimed the job then died),
 * we track `processingStartedAt`. Any job stuck in 'processing' for >
 * STALE_THRESHOLD_MS is reset to 'pending' at the top of every poll cycle.
 * This means a job can be attempted twice in the worst case — that is safe because
 * publishCommitment is idempotent for the same rootHash.
 *
 * ── Retry policy ───────────────────────────────────────────────────────────────
 *
 *   attempt 1 →  30s delay
 *   attempt 2 →  60s
 *   attempt 3 → 120s
 *   attempt 4 → 240s
 *   attempt 5 → 480s → status=failed
 *
 * A failed job means the save is still accessible via 0G Storage but has no
 * DA commitment. The operator should investigate the DA network and manually
 * re-enqueue if needed. The save's daStatus is set to 'failed' so players know
 * to wait (leaderboard submission requires daStatus='finalized').
 */

import mongoose from 'mongoose';
import { DAJob } from '../models/DAJob';
import { Save } from '../models/Save';
import { zgDA } from './ZeroGDA';
import { logger } from '../utils/logger';

// How long a job can sit in 'processing' before we assume the worker crashed
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

// Worker poll interval — how often to check for new jobs
const POLL_INTERVAL_MS = 15 * 1000; // 15 seconds

// Exponential backoff per attempt (capped at 8 minutes)
function backoffMs(attempt: number): number {
  return Math.min(30_000 * Math.pow(2, attempt - 1), 8 * 60 * 1000);
}

export class DAQueue {
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Persist a new DA job before the HTTP response is sent.
   * Even if the server dies immediately after, the job survives in MongoDB.
   */
  async enqueue(
    saveId: mongoose.Types.ObjectId,
    rootHash: string,
    walletAddress: string
  ): Promise<void> {
    await DAJob.create({
      saveId,
      rootHash,
      walletAddress: walletAddress.toLowerCase(),
      status: 'pending',
      nextRetryAt: new Date(), // due immediately
    });
    logger.debug('DA job enqueued', { saveId, rootHash });
  }

  /**
   * Start the background worker.
   * Call this once at server startup, after MongoDB is connected.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // First tick immediately — picks up any jobs left over from a crash/restart
    void this.tick();

    this.pollTimer = setInterval(() => {
      void this.tick();
    }, POLL_INTERVAL_MS);

    logger.info('DAQueue worker started', { pollIntervalMs: POLL_INTERVAL_MS });
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.running = false;
    logger.info('DAQueue worker stopped');
  }

  // ── Internal worker tick ──────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    try {
      // Step 1: Reset stale 'processing' jobs (worker crashed while holding them)
      const staleThreshold = new Date(Date.now() - STALE_THRESHOLD_MS);
      const staleReset = await DAJob.updateMany(
        {
          status: 'processing',
          processingStartedAt: { $lt: staleThreshold },
        },
        {
          $set: { status: 'pending' },
          $unset: { processingStartedAt: '' },
        }
      );
      if (staleReset.modifiedCount > 0) {
        logger.warn('DAQueue: reset stale processing jobs', {
          count: staleReset.modifiedCount,
        });
      }

      // Step 2: Claim one pending job atomically
      const job = await DAJob.findOneAndUpdate(
        {
          status: 'pending',
          nextRetryAt: { $lte: new Date() },
        },
        {
          $set: {
            status: 'processing',
            processingStartedAt: new Date(),
          },
        },
        { sort: { nextRetryAt: 1 }, new: true }
      );

      if (!job) return; // Nothing due right now

      logger.info('DAQueue: processing job', {
        jobId: job._id,
        saveId: job.saveId,
        rootHash: job.rootHash,
        attempt: job.attempts + 1,
      });

      try {
        // Step 3: Publish to 0G DA (synchronous — polls until FINALIZED)
        const commitment = await zgDA.publishCommitment(job.rootHash, job.walletAddress);

        // Step 4: Update the Save document
        await Save.findByIdAndUpdate(job.saveId, {
          daStatus: 'finalized',
          daCommitment: commitment,
        });

        // Step 5: Mark job done
        await DAJob.findByIdAndUpdate(job._id, {
          status: 'done',
          $unset: { processingStartedAt: '' },
        });

        logger.info('DAQueue: job complete', {
          jobId: job._id,
          rootHash: job.rootHash,
          batchId: commitment.batchId,
        });
      } catch (err) {
        const newAttempts = job.attempts + 1;
        const exhausted = newAttempts >= job.maxAttempts;

        const update = exhausted
          ? {
              status: 'failed' as const,
              attempts: newAttempts,
              lastError: (err as Error).message,
              $unset: { processingStartedAt: '' },
            }
          : {
              status: 'pending' as const,
              attempts: newAttempts,
              lastError: (err as Error).message,
              nextRetryAt: new Date(Date.now() + backoffMs(newAttempts)),
              $unset: { processingStartedAt: '' },
            };

        await DAJob.findByIdAndUpdate(job._id, update);

        if (exhausted) {
          // DA failed permanently — mark the save so the player sees it
          await Save.findByIdAndUpdate(job.saveId, { daStatus: 'failed' });

          logger.error('DAQueue: job exhausted all retries — DA failed permanently', {
            jobId: job._id,
            saveId: job.saveId,
            rootHash: job.rootHash,
            lastError: (err as Error).message,
          });
        } else {
          logger.warn('DAQueue: job failed, will retry', {
            jobId: job._id,
            attempt: newAttempts,
            maxAttempts: job.maxAttempts,
            nextRetryIn: `${backoffMs(newAttempts) / 1000}s`,
            err: (err as Error).message,
          });
        }
      }
    } catch (err) {
      // Catch-all: DB errors, unexpected throws — log and continue
      logger.error('DAQueue: tick error (non-fatal)', { err: (err as Error).message });
    }
  }
}

export const daQueue = new DAQueue();
