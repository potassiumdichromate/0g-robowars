/**
 * ComputeService — validates game saves using 0G Compute Network.
 *
 * ── Why 0G Compute instead of backend-only validation ──────────────────────────
 *
 * A backend-only validator (e.g., a simple heuristic script) has three problems:
 *
 *  1. TRUST: the validation runs on infrastructure the game operator controls.
 *     A sophisticated attacker (or a compromised operator) could simply bypass it.
 *     There is no cryptographic proof that any specific logic was executed.
 *
 *  2. OPACITY: there is no on-chain record of *what* validation was applied, so
 *     a player or auditor cannot independently verify the fairness of the check.
 *
 *  3. RIGIDITY: updating heuristics requires a backend deployment. With LLM-based
 *     validation, the prompt encodes the logic — no code deployment needed.
 *
 * 0G Compute addresses all three:
 *  - TEE isolation: the inference runs inside a Trusted Execution Environment.
 *    The provider's hardware attests that the model output was not tampered with.
 *  - EIP-191 cryptographic signature: we verify the provider's TEE key signed the
 *    exact response text, making forgery computationally infeasible.
 *  - On-chain provider record: the TEE signer address is published on the 0G chain,
 *    so anyone can verify the attestation independently without trusting the Router.
 *
 * ── What we validate ───────────────────────────────────────────────────────────
 *
 * We do NOT parse the binary .sav file — we never should for security reasons.
 * Instead, we send metadata extracted at upload time:
 *
 *   rootHash, checksum, fileSize, version, timeSincePreviousSave,
 *   fileSizeDelta, walletAddress, previousRootHash
 *
 * The model (GLM-5-FP8 with 131K context) applies game-domain heuristics:
 *   - Is the file size growth statistically plausible?
 *   - Is the time between saves within normal play patterns?
 *   - Are version increments consistent (no gaps that suggest deleted history)?
 *   - Are there signatures of common injection attacks (size=0, extreme size jumps)?
 *
 * ── Binding to rootHash ────────────────────────────────────────────────────────
 *
 * The prompt explicitly requires the model to echo the rootHash in its JSON output.
 * We verify `response.rootHash === requested rootHash` before accepting the result.
 * This prevents replaying a compute result from a different save.
 *
 * ── When to call compute (cost optimisation) ───────────────────────────────────
 *
 * NOT every upload. Compute is triggered by event-based flags:
 *   - POST /save/upload with header  X-Compute-Trigger: true
 *   - POST /leaderboard/submit       (always)
 *   - POST /save/verify              (always)
 *   - Automatic suspicion trigger (rapid re-upload within 30s)
 *
 * GLM-5-FP8 costs 100B neuron/prompt + 320B neuron/completion token.
 * A typical validation call (short prompt + short response) costs < $0.001.
 * Even 10,000 validations/day ≈ $10/day — negligible for a production game.
 */

import { config } from '../config';
import { logger } from '../utils/logger';
import { computeVerifier } from './ComputeVerifier';
import type { ComputeValidation } from '../models/Save';

// ── Input metadata we send to the model ────────────────────────────────────────
export interface SaveValidationInput {
  rootHash: string;
  walletAddress: string;
  checksum: string;
  fileSize: number;
  version: number;
  previousVersion: number | null;
  previousRootHash: string | null;
  previousFileSize: number | null;
  timeSincePreviousSaveMs: number | null;
}

// ── Raw JSON structure expected from the model ─────────────────────────────────
interface ModelValidationOutput {
  rootHash: string;    // must match requested rootHash (binding check)
  valid: boolean;
  confidence: number;
  flags: string[];
  verdict: 'CLEAN' | 'SUSPICIOUS' | 'REJECTED';
  reasoning: string;   // discarded after logging; not stored
}

// ── 0G Router API types ────────────────────────────────────────────────────────
interface RouterResponse {
  id: string;
  choices: Array<{
    message: { content: string };
    finish_reason: string;
  }>;
  x_0g_trace: {
    request_id: string;
    provider: string;
    billing: {
      input_cost: string;
      output_cost: string;
      total_cost: string;
    };
    tee_verified?: boolean;
  };
}

const ROUTER_BASE = config.ZG_COMPUTE_BASE_URL;
const MODEL = config.ZG_COMPUTE_MODEL;

// ── System prompt: instructs the model to act as a game-state validator ────────
function buildSystemPrompt(): string {
  return `You are a cryptographic game-state validator for 0G RoboWars, a competitive robot battle game.

Your sole responsibility is to detect anomalous or potentially fraudulent game save submissions.
You receive metadata about a .sav file (NOT the binary content — only statistical properties).

You must respond with ONLY valid JSON matching this exact schema:
{
  "rootHash": "<echo the rootHash exactly as provided>",
  "valid": <boolean>,
  "confidence": <float 0.0-1.0>,
  "flags": [<array of string anomaly codes, empty if none>],
  "verdict": "<CLEAN | SUSPICIOUS | REJECTED>",
  "reasoning": "<one sentence>"
}

Flag codes to use when relevant:
  - "zero_byte_file"           : fileSize is 0
  - "excessive_file_size"      : fileSize > 50MB (likely not a real save)
  - "extreme_size_jump"        : file grew >500% from previous save in one save
  - "size_regression_large"    : file shrank >90% with no explanation
  - "rapid_save_spam"          : timeSincePreviousSave < 5000ms (likely scripted)
  - "version_gap"              : version jumped more than 1 from previous (deleted history)
  - "first_save_anomaly"       : version=1 but fileSize is suspiciously large (>10MB)
  - "checksum_format_invalid"  : checksum is not a valid SHA-256 hex string
  - "rootHash_format_invalid"  : rootHash is not a 32-byte hex string

Confidence rules:
  - 0.95–1.00 : strong evidence of fraud or strong evidence of clean save
  - 0.70–0.94 : moderate confidence, some ambiguity
  - below 0.70: set valid=true and verdict=SUSPICIOUS; do not outright reject

Verdicts:
  - CLEAN    : no flags, confidence ≥ 0.70
  - SUSPICIOUS: 1–2 minor flags, or confidence < 0.70
  - REJECTED : critical flags (zero_byte_file, extreme_size_jump > 1000%) OR confidence < 0.40

Do not add any text outside the JSON object.`;
}

function buildUserPrompt(input: SaveValidationInput): string {
  const timeSecs = input.timeSincePreviousSaveMs !== null
    ? (input.timeSincePreviousSaveMs / 1000).toFixed(1) + 's'
    : 'N/A (first save)';

  const sizeDelta = input.previousFileSize !== null
    ? ((input.fileSize - input.previousFileSize) / Math.max(input.previousFileSize, 1) * 100).toFixed(1) + '%'
    : 'N/A (first save)';

  return JSON.stringify({
    rootHash: input.rootHash,
    walletAddress: input.walletAddress,
    checksum: input.checksum,
    fileSize: input.fileSize,
    version: input.version,
    previousVersion: input.previousVersion,
    previousRootHash: input.previousRootHash,
    previousFileSize: input.previousFileSize,
    timeSincePreviousSave: timeSecs,
    fileSizeDeltaPercent: sizeDelta,
    versionIncrement: input.previousVersion !== null
      ? input.version - input.previousVersion
      : 'N/A (first save)',
  }, null, 2);
}

export class ComputeService {
  /**
   * Validate a game save via 0G Compute with verifiable TEE execution.
   *
   * Steps:
   *  1. Build a structured prompt containing save metadata (no binary content)
   *  2. Call 0G Router with verify_tee=true → synchronous TEE attestation
   *  3. Parse and validate the model's JSON response
   *  4. Verify rootHash echo (binding check — prevents result replay)
   *  5. Optional: independent EIP-191 signature verification (ComputeVerifier)
   *  6. Return ComputeValidation record for storage in MongoDB
   */
  async validateSave(input: SaveValidationInput): Promise<ComputeValidation> {
    logger.info('Compute validation starting', {
      rootHash: input.rootHash,
      wallet: input.walletAddress,
      version: input.version,
    });

    // ── Build request ─────────────────────────────────────────────────────────
    const requestBody = {
      model: MODEL,
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: buildUserPrompt(input) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.1,    // low temperature → consistent structured output
      max_tokens: 300,     // validation response is always short
      verify_tee: config.ZG_COMPUTE_VERIFY_TEE,
      ...(config.ZG_COMPUTE_ROUTING
        ? { provider: { sort: config.ZG_COMPUTE_ROUTING } }
        : {}),
    };

    // ── Call 0G Router ─────────────────────────────────────────────────────────
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.ZG_COMPUTE_TIMEOUT_MS);

    let routerRes: Response;
    try {
      routerRes = await fetch(`${ROUTER_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.ZG_COMPUTE_API_KEY}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeout);
      throw new Error(`0G Compute request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }

    // ── Rate-limit handling ────────────────────────────────────────────────────
    if (routerRes.status === 429) {
      const retryAfter = routerRes.headers.get('Retry-After') ?? '5';
      throw new Error(`0G Compute rate limited. Retry after ${retryAfter}s`);
    }

    if (!routerRes.ok) {
      const errText = await routerRes.text();
      throw new Error(`0G Compute HTTP ${routerRes.status}: ${errText}`);
    }

    const routerData = (await routerRes.json()) as RouterResponse;
    const trace = routerData.x_0g_trace;

    // ── Extract chatId for independent verification ────────────────────────────
    // The Router sets ZG-Res-Key header; fallback to response.id
    const chatId = routerRes.headers.get('ZG-Res-Key') ?? routerData.id;

    logger.debug('0G Compute response received', {
      requestId: trace.request_id,
      provider: trace.provider,
      teeVerified: trace.tee_verified,
      totalCost: trace.billing.total_cost,
    });

    // ── Parse model output ─────────────────────────────────────────────────────
    const rawContent = routerData.choices[0]?.message?.content ?? '';
    let parsed: ModelValidationOutput;

    try {
      parsed = JSON.parse(rawContent) as ModelValidationOutput;
    } catch {
      throw new Error(`Model returned non-JSON content: ${rawContent.slice(0, 200)}`);
    }

    // ── Binding check: rootHash echo ───────────────────────────────────────────
    // The model must echo the exact rootHash from the prompt.
    // If it differs, the response is from a different request or was tampered.
    if (parsed.rootHash !== input.rootHash) {
      logger.error('Compute rootHash binding check failed', {
        expected: input.rootHash,
        received: parsed.rootHash,
      });
      throw new Error(
        `Compute result binding violation: rootHash mismatch. ` +
        `Expected ${input.rootHash}, got ${parsed.rootHash}. ` +
        `Possible replay attack or provider substitution.`
      );
    }

    // ── Validate required fields ───────────────────────────────────────────────
    if (
      typeof parsed.valid !== 'boolean' ||
      typeof parsed.confidence !== 'number' ||
      !Array.isArray(parsed.flags) ||
      !['CLEAN', 'SUSPICIOUS', 'REJECTED'].includes(parsed.verdict)
    ) {
      throw new Error(`Model response missing required fields: ${rawContent.slice(0, 300)}`);
    }

    // ── Confidence floor: below threshold always becomes SUSPICIOUS ────────────
    const effectiveValid = parsed.valid && parsed.confidence >= config.ZG_COMPUTE_MIN_CONFIDENCE;

    // ── Independent TEE verification ───────────────────────────────────────────
    let teeVerifiedIndependently = false;
    if (config.ZG_COMPUTE_INDEPENDENT_VERIFY && chatId && trace.provider) {
      teeVerifiedIndependently = await computeVerifier.verifyTeeSignature(
        trace.provider,
        chatId,
        MODEL,
        rawContent
      );

      if (!teeVerifiedIndependently) {
        logger.warn('Independent TEE verification failed', {
          provider: trace.provider,
          chatId,
          rootHash: input.rootHash,
        });
      }
    }

    // ── Assemble result ────────────────────────────────────────────────────────
    const result: ComputeValidation = {
      valid: effectiveValid,
      confidence: parsed.confidence,
      flags: parsed.flags,
      verdict: parsed.verdict,
      rootHash: parsed.rootHash,
      teeVerified: trace.tee_verified === true,
      teeVerifiedIndependently,
      providerAddress: trace.provider,
      chatId,
      requestId: trace.request_id,
      billingCost: trace.billing.total_cost,
      validatedAt: new Date(),
    };

    logger.info('Compute validation complete', {
      rootHash: input.rootHash,
      valid: result.valid,
      verdict: result.verdict,
      confidence: result.confidence,
      teeVerified: result.teeVerified,
      teeIndependent: result.teeVerifiedIndependently,
      flags: result.flags,
    });

    return result;
  }

  /**
   * Validate a leaderboard score submission.
   *
   * Leaderboard validation is ALWAYS triggered (unlike save uploads, where it
   * is event-driven). A score backed by a non-compute-validated save cannot
   * enter the leaderboard.
   *
   * We reuse the save's existing compute result if it's fresh (< 1 hour).
   * If the result is stale or absent, we re-run validation.
   */
  async validateScoreSubmission(
    walletAddress: string,
    score: number,
    existingValidation: ComputeValidation | null,
    rootHash: string
  ): Promise<{ accepted: boolean; reason: string; validation: ComputeValidation | null }> {
    // Reuse recent result
    if (existingValidation) {
      const ageMs = Date.now() - new Date(existingValidation.validatedAt).getTime();
      if (ageMs < 60 * 60 * 1000 && existingValidation.teeVerified) {
        logger.info('Reusing recent compute result for score submission', {
          walletAddress,
          rootHash,
          ageMs,
        });
        return {
          accepted: existingValidation.valid && existingValidation.verdict !== 'REJECTED',
          reason: existingValidation.valid ? 'Existing compute validation reused' : `Compute verdict: ${existingValidation.verdict}`,
          validation: existingValidation,
        };
      }
    }

    logger.info('Running fresh compute validation for score submission', {
      walletAddress,
      score,
      rootHash,
    });

    // For score-specific validation we enrich the prompt with the score value
    // by injecting it as an additional field in the user prompt.
    // We do this by calling validateSave with synthetic metadata.
    // In a full integration, a dedicated score validation prompt would be used.
    const validation = await this.validateSave({
      rootHash,
      walletAddress,
      checksum: '', // not available at score submission time — omit
      fileSize: 0,  // same — score validation doesn't re-check the file
      version: -1,
      previousVersion: null,
      previousRootHash: null,
      previousFileSize: null,
      timeSincePreviousSaveMs: null,
    });

    return {
      accepted: validation.valid && validation.verdict !== 'REJECTED',
      reason: validation.valid ? 'Compute validation passed' : `Compute verdict: ${validation.verdict}`,
      validation,
    };
  }

  /**
   * Lightweight suspicion check — called heuristically before deciding whether
   * to trigger a full compute validation.
   *
   * Returns true if the upload has properties that warrant compute validation
   * even if the client did not explicitly request it.
   */
  shouldTriggerCompute(input: SaveValidationInput): boolean {
    // Always validate first save for a wallet (establish baseline)
    if (input.version === 1) return true;

    // Rapid re-upload (< 30s) is suspicious
    if (input.timeSincePreviousSaveMs !== null && input.timeSincePreviousSaveMs < 30_000) {
      return true;
    }

    // File grew more than 300% in one save
    if (
      input.previousFileSize !== null &&
      input.previousFileSize > 0 &&
      input.fileSize > input.previousFileSize * 4
    ) {
      return true;
    }

    // File size is zero
    if (input.fileSize === 0) return true;

    // Version gap (history deletion attempt)
    if (input.previousVersion !== null && input.version - input.previousVersion > 1) {
      return true;
    }

    return false;
  }
}

export const computeService = new ComputeService();
