import { Router, Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { requireAuth, assertOwner } from '../middleware/authMiddleware';
import { uploadRateLimiter } from '../middleware/rateLimiter';
import { upload, validateSavFile } from '../middleware/fileValidator';
import { zgStorage } from '../services/ZeroGStorage';
import { zgDA } from '../services/ZeroGDA';
import { daQueue } from '../services/DAQueue';
import { computeService } from '../services/ComputeService';
import { Save } from '../models/Save';
import { logger } from '../utils/logger';

export const saveRouter = Router();

// All save routes require a valid JWT
saveRouter.use(requireAuth);

// ── POST /save/upload ──────────────────────────────────────────────────────────
/**
 * Upload a .sav file, store it on 0G Storage, and publish a DA commitment.
 *
 * Updated Flow (with 0G Compute):
 *  1. Multer writes file to /tmp
 *  2. fileValidator checks GVAS magic + computes SHA-256
 *  3. zgStorage.upload() → rootHash (Merkle root), txHash (EVM tx)
 *  4. Compute gate (conditional):
 *       - Triggered by header X-Compute-Trigger: true
 *       - OR auto-triggered by ComputeService.shouldTriggerCompute()
 *       - Calls 0G Compute Router with verify_tee=true
 *       - REJECTS upload if verdict === REJECTED (save never enters DB/DA)
 *  5. Persist Save record (computeStatus reflects validation outcome)
 *  6. Async: zgDA.publishCommitment() — updates daStatus on finality
 *  7. Return rootHash + computeStatus to client
 *
 * Compute validation is synchronous and BLOCKS the response when triggered.
 * This is intentional: an invalid save must never reach the DA layer.
 */
saveRouter.post(
  '/upload',
  uploadRateLimiter,
  upload.single('savefile'),
  validateSavFile,
  async (req: Request, res: Response) => {
    const { walletAddress } = req;
    const file = req.file!;

    const uploadedPath = file.path;

    try {
      // Determine next version number + fetch previous save metadata for compute
      const latest = await Save.findOne({ walletAddress })
        .sort({ version: -1 })
        .select('version rootHash fileSize createdAt')
        .lean();

      const version = (latest?.version ?? 0) + 1;

      // ── Step 1: Upload binary blob to 0G Storage ─────────────────────────────
      const { rootHash, txHash } = await zgStorage.upload(uploadedPath);

      // ── Step 2: Compute gate ──────────────────────────────────────────────────
      // Triggered explicitly via header, or auto-triggered by suspicion heuristics.
      const explicitTrigger = req.headers['x-compute-trigger'] === 'true';
      const timeSincePrevious = latest?.createdAt
        ? Date.now() - new Date(latest.createdAt).getTime()
        : null;

      const computeInput = {
        rootHash,
        walletAddress,
        checksum: file.checksum,
        fileSize: file.size,
        version,
        previousVersion: latest?.version ?? null,
        previousRootHash: latest?.rootHash ?? null,
        previousFileSize: latest?.fileSize ?? null,
        timeSincePreviousSaveMs: timeSincePrevious,
      };

      const autoTrigger = computeService.shouldTriggerCompute(computeInput);
      const runCompute = explicitTrigger || autoTrigger;

      let computeValidation = null;
      let computeStatus: 'skipped' | 'pending' | 'validated' | 'rejected' = 'skipped';

      if (runCompute) {
        logger.info('Compute validation triggered', {
          walletAddress,
          rootHash,
          reason: explicitTrigger ? 'explicit-header' : 'auto-heuristic',
        });

        try {
          computeValidation = await computeService.validateSave(computeInput);

          if (computeValidation.verdict === 'REJECTED') {
            // Hard rejection: save never enters DB or DA
            logger.warn('Save REJECTED by compute validation', {
              walletAddress,
              rootHash,
              flags: computeValidation.flags,
              confidence: computeValidation.confidence,
            });
            res.status(400).json({
              error: 'Save rejected by 0G Compute validation',
              verdict: computeValidation.verdict,
              confidence: computeValidation.confidence,
              flags: computeValidation.flags,
              teeVerified: computeValidation.teeVerified,
              providerAddress: computeValidation.providerAddress,
            });
            return;
          }

          computeStatus = 'validated';
        } catch (computeErr) {
          // Compute failures are logged but do NOT block the upload.
          // We record computeStatus='pending' so operators can re-run later.
          // This prevents a Compute network outage from breaking save functionality.
          logger.error('Compute validation failed (non-blocking)', {
            walletAddress,
            rootHash,
            err: computeErr,
          });
          computeStatus = 'pending';
        }
      }

      // ── Step 3: Persist save record ───────────────────────────────────────────
      const saveDoc = await Save.create({
        walletAddress,
        version,
        rootHash,
        txHash,
        checksum: file.checksum,
        fileSize: file.size,
        daStatus: 'pending',
        daCommitment: null,
        computeValidation,
        computeStatus,
      });

      logger.info('Save record created', { walletAddress, version, rootHash, computeStatus });

      // Enqueue DA commitment BEFORE sending the response.
      // The job is now durable in MongoDB — a server crash between here
      // and finalization no longer loses the commitment. The DAQueue worker
      // picks it up on the next poll cycle (or on restart).
      await daQueue.enqueue(saveDoc._id, rootHash, walletAddress);

      // Respond to client — DA will finalize asynchronously via the queue
      res.status(201).json({
        message: 'Save uploaded successfully',
        version,
        rootHash,
        txHash,
        checksum: file.checksum,
        daStatus: 'pending',
        computeStatus,
        computeVerdict: computeValidation?.verdict ?? null,
        computeConfidence: computeValidation?.confidence ?? null,
        teeVerified: computeValidation?.teeVerified ?? null,
        saveId: saveDoc._id,
      });
    } catch (err) {
      logger.error('Save upload failed', { walletAddress, err });
      res.status(500).json({ error: 'Upload failed. Please try again.' });
    } finally {
      // Always clean up the temp file
      if (fs.existsSync(uploadedPath)) {
        fs.unlinkSync(uploadedPath);
      }
    }
  }
);

// ── GET /save/latest ───────────────────────────────────────────────────────────
/**
 * Return the latest save metadata for the authenticated wallet.
 * Does NOT return file bytes — use /save/download for that.
 */
saveRouter.get('/latest', async (req: Request, res: Response) => {
  const { walletAddress } = req;

  const save = await Save.findOne({ walletAddress })
    .sort({ version: -1 })
    .lean();

  if (!save) {
    res.status(404).json({ error: 'No saves found for this wallet' });
    return;
  }

  res.json({
    version: save.version,
    rootHash: save.rootHash,
    txHash: save.txHash,
    checksum: save.checksum,
    fileSize: save.fileSize,
    daStatus: save.daStatus,
    daCommitment: save.daCommitment,
    createdAt: save.createdAt,
  });
});

// ── GET /save/history ──────────────────────────────────────────────────────────
/**
 * Return all save versions for the authenticated wallet (newest first).
 * Useful for rollback / cross-device sync decisions.
 */
saveRouter.get('/history', async (req: Request, res: Response) => {
  const saves = await Save.find({ walletAddress: req.walletAddress })
    .sort({ version: -1 })
    .select('version rootHash checksum fileSize daStatus createdAt')
    .limit(50)
    .lean();

  res.json({ saves, count: saves.length });
});

// ── GET /save/download ─────────────────────────────────────────────────────────
/**
 * Stream the .sav binary back to the Unreal client.
 *
 * Security:
 *  - Only the owner wallet can download their own saves.
 *  - 0G Storage SDK verifies Merkle proofs on every segment before we stream.
 *  - We re-verify the SHA-256 checksum against the DB record before sending.
 *    If the file was corrupted or substituted on the storage layer,
 *    this check catches it.
 *
 * Query params:
 *  - version (optional): specific version to download; defaults to latest
 */
saveRouter.get('/download', async (req: Request, res: Response) => {
  const { walletAddress } = req;
  const version = req.query['version'] ? parseInt(req.query['version'] as string, 10) : null;

  const query = version
    ? { walletAddress, version }
    : { walletAddress };

  const save = version
    ? await Save.findOne(query).lean()
    : await Save.findOne(query).sort({ version: -1 }).lean();

  if (!save) {
    res.status(404).json({ error: 'Save not found' });
    return;
  }

  if (!assertOwner(req, res, save.walletAddress)) return;

  const tmpPath = path.join(
    process.cwd(),
    'tmp',
    `dl_${Date.now()}_${walletAddress}.sav`
  );

  try {
    // Download from 0G Storage with Merkle proof verification
    await zgStorage.download(save.rootHash, tmpPath);

    // Re-verify checksum against our DB record
    const data = fs.readFileSync(tmpPath);
    const actualChecksum = crypto.createHash('sha256').update(data).digest('hex');

    if (actualChecksum !== save.checksum) {
      logger.error('Checksum mismatch on download — possible tampering', {
        walletAddress,
        rootHash: save.rootHash,
        expected: save.checksum,
        actual: actualChecksum,
      });
      res.status(500).json({
        error: 'Integrity check failed. File checksum does not match stored record.',
        rootHash: save.rootHash,
      });
      return;
    }

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="robowars_v${save.version}.sav"`);
    res.setHeader('Content-Length', data.length);
    res.setHeader('X-RootHash', save.rootHash);
    res.setHeader('X-Checksum', save.checksum);
    res.setHeader('X-Version', save.version);
    res.setHeader('X-DA-Status', save.daStatus);

    res.send(data);

    logger.info('Save downloaded', { walletAddress, version: save.version, rootHash: save.rootHash });
  } catch (err) {
    logger.error('Download failed', { walletAddress, rootHash: save.rootHash, err });
    res.status(500).json({ error: 'Failed to retrieve save from 0G Storage' });
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
});

// ── POST /save/verify ──────────────────────────────────────────────────────────
/**
 * Anti-cheat verification endpoint.
 *
 * Verifies that a player's current save:
 *  1. Has a valid DA commitment on 0G DA (proves it wasn't injected post-hoc)
 *  2. The rootHash in the DA blob matches our DB record
 *  3. The file bytes match the stored SHA-256 checksum
 *
 * This is the core anti-cheat primitive. A leaderboard contract or
 * game server calls this before accepting any ranked submission.
 */
saveRouter.post('/verify', async (req: Request, res: Response) => {
  const { walletAddress } = req;
  const { rootHash } = req.body as { rootHash?: string };

  if (!rootHash) {
    res.status(400).json({ error: 'rootHash is required' });
    return;
  }

  const save = await Save.findOne({ walletAddress, rootHash }).lean();

  if (!save) {
    res.status(404).json({ error: 'Save not found for this wallet + rootHash' });
    return;
  }

  const result = {
    rootHash,
    version: save.version,
    checksumMatch: false,
    daCommitmentValid: false,
    verdict: 'UNVERIFIED' as 'UNVERIFIED' | 'CLEAN' | 'TAMPERED',
  };

  // Step 1: verify DA commitment
  if (save.daStatus !== 'finalized' || !save.daCommitment) {
    res.json({ ...result, verdict: 'UNVERIFIED', reason: 'DA not yet finalized' });
    return;
  }

  result.daCommitmentValid = await zgDA.verifyCommitment(save.daCommitment, rootHash);

  // Step 2: re-download and verify checksum
  const tmpPath = path.join(process.cwd(), 'tmp', `verify_${Date.now()}.sav`);
  try {
    await zgStorage.download(rootHash, tmpPath);
    const data = fs.readFileSync(tmpPath);
    const actualChecksum = crypto.createHash('sha256').update(data).digest('hex');
    result.checksumMatch = actualChecksum === save.checksum;
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }

  result.verdict =
    result.daCommitmentValid && result.checksumMatch ? 'CLEAN' : 'TAMPERED';

  logger.info('Save verification result', { walletAddress, rootHash, verdict: result.verdict });
  res.json(result);
});
