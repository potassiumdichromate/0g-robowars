/**
 * Leaderboard routes — score submission backed by four-layer verification:
 *
 *  1. DB integrity      — rootHash must exist in our DB for this wallet
 *  2. DA commitment     — rootHash is BLS-signed by >2/3 of 0G DA nodes on-chain
 *  3. Storage checksum  — file re-downloaded and SHA-256 verified
 *  4. Compute (TEE)     — 0G Compute Router runs GLM-5-FP8 inside a TEE,
 *                         EIP-191 signed by the provider's attested hardware key
 *
 * ALL four layers must pass. A score backed by a save that fails compute
 * attestation is silently rejected — the player receives no useful error
 * information that would help them craft a passing fraudulent save.
 */

import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/authMiddleware';
import { antiCheatService } from '../services/AntiCheatService';
import { logger } from '../utils/logger';

export const leaderboardRouter = Router();

// ── Schema ────────────────────────────────────────────────────────────────────
interface ILeaderboardEntry {
  walletAddress: string;
  score: number;
  saveRootHash: string;
  saveVersion: number;
  computeVerdict: string;
  computeProvider: string;
  verifiedAt: Date;
}

const EntrySchema = new mongoose.Schema<ILeaderboardEntry>(
  {
    walletAddress: { type: String, required: true, unique: true, lowercase: true },
    score: { type: Number, required: true },
    saveRootHash: { type: String, required: true },
    saveVersion: { type: Number, required: true },
    computeVerdict: { type: String, default: '' },
    computeProvider: { type: String, default: '' },
    verifiedAt: { type: Date, required: true },
  },
  { collection: 'leaderboard', timestamps: true }
);
EntrySchema.index({ score: -1 });

const LeaderboardEntry = mongoose.model<ILeaderboardEntry>('LeaderboardEntry', EntrySchema);

// ── POST /leaderboard/submit ────────────────────────────────────────────────
leaderboardRouter.post('/submit', requireAuth, async (req: Request, res: Response) => {
  const { score } = req.body as { score?: number };

  if (typeof score !== 'number' || score < 0) {
    res.status(400).json({ error: 'score must be a non-negative number' });
    return;
  }

  const { walletAddress } = req;

  const { accepted, reason, report } = await antiCheatService.verifySaveForScore(
    walletAddress,
    score
  );

  if (!accepted) {
    logger.warn('Leaderboard score rejected', { walletAddress, score, reason });
    res.status(403).json({ error: reason, report });
    return;
  }

  // Upsert — only keep the player's best-ever score IF it's higher
  const existing = await LeaderboardEntry.findOne({ walletAddress });

  if (existing && existing.score >= score) {
    res.json({
      message: 'Score not updated (existing score is higher)',
      currentBest: existing.score,
    });
    return;
  }

  await LeaderboardEntry.findOneAndUpdate(
    { walletAddress },
    {
      walletAddress,
      score,
      saveRootHash: report!.rootHash,
      saveVersion: report!.version,
      computeVerdict: report!.computeValidation?.verdict ?? 'SKIPPED',
      computeProvider: report!.computeValidation?.providerAddress ?? '',
      verifiedAt: new Date(),
    },
    { upsert: true, new: true }
  );

  logger.info('Leaderboard score accepted', { walletAddress, score });
  res.json({ message: 'Score submitted', score, verdict: report?.verdict });
});

// ── GET /leaderboard/top ────────────────────────────────────────────────────
leaderboardRouter.get('/top', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt((req.query['limit'] as string) ?? '100', 10), 100);

  const entries = await LeaderboardEntry.find()
    .sort({ score: -1 })
    .limit(limit)
    .select('walletAddress score saveVersion computeVerdict computeProvider verifiedAt -_id')
    .lean();

  res.json({ entries, count: entries.length });
});
