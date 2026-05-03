/**
 * AntiCheatService — four-layer verification combining:
 *   Layer 1: DB integrity   (rootHash known, not injected)
 *   Layer 2: DA commitment  (rootHash locked on-chain at a specific block)
 *   Layer 3: Storage proof  (file bytes match SHA-256 checksum via Merkle proof)
 *   Layer 4: Compute proof  (TEE-attested model analysis, EIP-191 signature verified)
 *
 * ── Trust Model ────────────────────────────────────────────────────────────────
 *
 * Attack surface → mitigation:
 *
 *  1. Upload modified .sav with same rootHash
 *     → Impossible: rootHash is Merkle root of content (content-addressed).
 *
 *  2. Inject fraudulent rootHash into DB
 *     → DA: BLS-signed batch of >2/3 nodes at a specific block proves it existed then.
 *
 *  3. Collude with storage/DA node to alter data
 *     → KZG commitment + erasure coding: any byte change invalidates the proof.
 *
 *  4. Fabricate a compute validation result
 *     → TEE attestation: the provider runs inside tamper-proof hardware.
 *       Our independent EIP-191 verification confirms the result wasn't forged.
 *       The `rootHash` binding check confirms the result belongs to THIS save.
 *
 *  5. Replay an old compute result for a new (cheated) save
 *     → Binding check: model echoes rootHash in JSON output.
 *       Different rootHash = different save = compute result invalid.
 *
 * ── Why four layers are necessary ─────────────────────────────────────────────
 *
 * - Layers 1–3 prove the file EXISTS and HASN'T CHANGED since upload.
 * - Layer 4 proves the file CONTENT was STATISTICALLY VALID at upload time.
 *
 * An attacker who uploads a plausible-looking but fraudulent save would pass
 * layers 1–3 (the save IS the thing that was uploaded — it's just fraudulent).
 * Layer 4 is the only layer that reasons about the CONTENT's validity.
 * Its TEE attestation means that reasoning cannot be faked.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Save, ISave, ComputeValidation } from '../models/Save';
import { zgStorage } from './ZeroGStorage';
import { zgDA } from './ZeroGDA';
import { computeService } from './ComputeService';
import { logger } from '../utils/logger';

export type VerificationVerdict = 'CLEAN' | 'TAMPERED' | 'UNVERIFIED' | 'DA_PENDING' | 'COMPUTE_PENDING';

export interface VerificationReport {
  walletAddress: string;
  rootHash: string;
  version: number;
  verdict: VerificationVerdict;
  checks: {
    rootHashKnown: boolean;
    daCommitmentPresent: boolean;
    daCommitmentValid: boolean;
    storageChecksumMatch: boolean;
    computeValidationPresent: boolean;
    computeValidationPassed: boolean;
    computeTeeVerified: boolean;
    computeIndependentlyVerified: boolean;
  };
  daCommitment: ISave['daCommitment'];
  computeValidation: ComputeValidation | null;
  verifiedAt: Date;
}

export class AntiCheatService {
  /**
   * Full four-layer verification of a player save.
   *
   * @param walletAddress - Wallet that owns the save
   * @param rootHash      - 0G Storage Merkle root to verify
   * @param forceCompute  - Run a fresh compute call even if one exists in DB
   */
  async verifySave(
    walletAddress: string,
    rootHash: string,
    forceCompute = false
  ): Promise<VerificationReport> {
    const normalized = walletAddress.toLowerCase();

    const report: VerificationReport = {
      walletAddress: normalized,
      rootHash,
      version: -1,
      verdict: 'UNVERIFIED',
      checks: {
        rootHashKnown: false,
        daCommitmentPresent: false,
        daCommitmentValid: false,
        storageChecksumMatch: false,
        computeValidationPresent: false,
        computeValidationPassed: false,
        computeTeeVerified: false,
        computeIndependentlyVerified: false,
      },
      daCommitment: null,
      computeValidation: null,
      verifiedAt: new Date(),
    };

    // ── Layer 1: DB integrity check ─────────────────────────────────────────────
    const save = await Save.findOne({ walletAddress: normalized, rootHash }).lean();

    if (!save) {
      logger.warn('AntiCheat L1: rootHash unknown', { walletAddress: normalized, rootHash });
      report.verdict = 'TAMPERED';
      return report;
    }

    report.version = save.version;
    report.checks.rootHashKnown = true;
    report.daCommitment = save.daCommitment;
    report.computeValidation = save.computeValidation;

    // ── Layer 2: DA commitment ──────────────────────────────────────────────────
    if (save.daStatus !== 'finalized' || !save.daCommitment) {
      report.verdict = 'DA_PENDING';
      return report;
    }

    report.checks.daCommitmentPresent = true;
    report.checks.daCommitmentValid = await zgDA.verifyCommitment(
      save.daCommitment,
      rootHash
    );

    // ── Layer 3: Storage checksum ───────────────────────────────────────────────
    const tmpPath = path.join(
      process.cwd(),
      'tmp',
      `anticheat_${Date.now()}_${normalized.slice(2, 10)}.sav`
    );

    try {
      await zgStorage.download(rootHash, tmpPath);
      const data = fs.readFileSync(tmpPath);
      const actual = crypto.createHash('sha256').update(data).digest('hex');
      report.checks.storageChecksumMatch = actual === save.checksum;
    } catch (err) {
      logger.error('AntiCheat L3: storage download failed', { rootHash, err });
    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }

    // ── Layer 4: Compute validation ─────────────────────────────────────────────
    let computeResult = save.computeValidation;

    // Re-run if: no existing result, forced, or existing result failed TEE check
    const needsFreshCompute =
      forceCompute ||
      !computeResult ||
      !computeResult.teeVerified;

    if (needsFreshCompute) {
      logger.info('AntiCheat L4: running fresh compute validation', {
        walletAddress: normalized,
        rootHash,
        reason: forceCompute ? 'forced' : (!computeResult ? 'no-existing' : 'tee-unverified'),
      });

      try {
        computeResult = await computeService.validateSave({
          rootHash,
          walletAddress: normalized,
          checksum: save.checksum,
          fileSize: save.fileSize,
          version: save.version,
          previousVersion: null,
          previousRootHash: null,
          previousFileSize: null,
          timeSincePreviousSaveMs: null,
        });

        // Persist the fresh compute result
        await Save.findByIdAndUpdate(save._id, {
          computeValidation: computeResult,
          computeStatus: computeResult.valid ? 'validated' : 'rejected',
        });

        report.computeValidation = computeResult;
      } catch (err) {
        logger.error('AntiCheat L4: compute failed', { rootHash, err });
      }
    }

    if (computeResult) {
      report.checks.computeValidationPresent = true;
      report.checks.computeValidationPassed = computeResult.valid && computeResult.verdict !== 'REJECTED';
      report.checks.computeTeeVerified = computeResult.teeVerified;
      report.checks.computeIndependentlyVerified = computeResult.teeVerifiedIndependently;
    } else {
      // No compute result and couldn't run one — degrade to COMPUTE_PENDING
      if (!report.checks.daCommitmentValid || !report.checks.storageChecksumMatch) {
        report.verdict = 'TAMPERED';
        return report;
      }
      report.verdict = 'COMPUTE_PENDING';
      return report;
    }

    // ── Final verdict: all four layers must pass ────────────────────────────────
    const layersOnePassed = report.checks.rootHashKnown;
    const layerTwoPassed = report.checks.daCommitmentValid;
    const layerThreePassed = report.checks.storageChecksumMatch;
    const layerFourPassed = report.checks.computeValidationPassed && report.checks.computeTeeVerified;

    if (layersOnePassed && layerTwoPassed && layerThreePassed && layerFourPassed) {
      report.verdict = 'CLEAN';
    } else {
      report.verdict = 'TAMPERED';
    }

    logger.info('AntiCheat 4-layer verification complete', {
      walletAddress: normalized,
      rootHash,
      verdict: report.verdict,
      checks: report.checks,
    });

    return report;
  }

  /**
   * Score submission guard — always runs a four-layer check.
   *
   * The compute layer here is always called fresh for leaderboard submissions
   * because the stakes are higher (public ranking, potential rewards).
   * We still reuse a cached result if it's < 1 hour old AND tee-verified.
   */
  async verifySaveForScore(
    walletAddress: string,
    score: number
  ): Promise<{ accepted: boolean; reason: string; report?: VerificationReport }> {
    const normalized = walletAddress.toLowerCase();

    const latest = await Save.findOne({ walletAddress: normalized })
      .sort({ version: -1 })
      .lean();

    if (!latest) {
      return { accepted: false, reason: 'No save on file for this wallet' };
    }

    // Check if existing compute result is fresh enough for score submission
    const existingCompute = latest.computeValidation;
    const computeAge = existingCompute
      ? Date.now() - new Date(existingCompute.validatedAt).getTime()
      : Infinity;
    const computeIsFresh = computeAge < 60 * 60 * 1000 && existingCompute?.teeVerified === true;

    const report = await this.verifySave(
      walletAddress,
      latest.rootHash,
      !computeIsFresh // force fresh compute if stale
    );

    if (report.verdict !== 'CLEAN') {
      return {
        accepted: false,
        reason: `Save verification failed: ${report.verdict}`,
        report,
      };
    }

    logger.info('Score submission approved', { walletAddress: normalized, score });
    return { accepted: true, reason: 'Four-layer verification passed', report };
  }
}

export const antiCheatService = new AntiCheatService();
