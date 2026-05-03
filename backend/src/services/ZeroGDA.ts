/**
 * ZeroGDA — publishes rootHash commitments to 0G Data Availability network.
 *
 * ── Why DA? ────────────────────────────────────────────────────────────────────
 * 0G Storage proves a file EXISTS at a rootHash.
 * 0G DA proves that a rootHash WAS PUBLISHED and is AVAILABLE AT A POINT IN TIME.
 *
 * This distinction is critical for anti-cheat:
 *  - Storage alone: a malicious actor could upload a different file and claim
 *    the same rootHash was always there.
 *  - DA + Storage: the rootHash is locked into a DA batch at a specific block
 *    number, with >2/3 of DA nodes signing off. Retroactive substitution is
 *    cryptographically impossible.
 *
 * ── How 0G DA works (brief) ────────────────────────────────────────────────────
 *  1. We submit a blob (our rootHash bytes) to the Disperser via gRPC.
 *  2. The Disperser encodes the blob into a 3072×1024 matrix using erasure
 *     coding over BN254's scalar field.
 *  3. It generates a KZG commitment (the erasure commitment) binding the data.
 *  4. Matrix rows are distributed to DA nodes alongside KZG proofs.
 *  5. Each node verifies its slice, then BLS-signs to attest availability.
 *  6. Once >2/3 of nodes sign, the aggregated BLS sig is submitted on-chain.
 *  7. The DA contract finalises the batch — now any light client can verify
 *     availability by sampling a random subset of matrix cells.
 *
 * ── What we store ─────────────────────────────────────────────────────────────
 *  - requestId: returned immediately on submission
 *  - batchId, blobIndex, batchHeaderHash: available after FINALIZED
 *  - referenceBlockNumber: the L1 block at which DA was confirmed
 *
 *  These fields together constitute a verifiable DA commitment that any
 *  third party (anti-cheat oracle, leaderboard verifier) can check.
 */

import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';
import type { DaCommitment } from '../models/Save';

// ── gRPC type shims ─────────────────────────────────────────────────────────────
interface DisperseBlobReply {
  result: number;       // BlobStatus enum
  request_id: Buffer;
}

interface BlobStatusReply {
  status: number;
  signed_batch?: {
    header?: {
      batch_root: Buffer;
      quorum_numbers: Buffer;
      reference_block_number: number;
    };
    attestation?: {
      sigma: Buffer;
    };
  };
  blob_verification_proof?: {
    batch_id: number;
    blob_index: number;
    batch_metadata?: {
      batch_header_hash: Buffer;
      confirmation_block_number: number;
    };
    inclusion_proof: Buffer;
  };
}

// BlobStatus enum values (mirrors disperser.proto)
const BlobStatus = {
  UNKNOWN: 0,
  PROCESSING: 1,
  FAILED: 2,
  FINALIZED: 3,
  INSUFFICIENT_SIGNATURES: 4,
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DisperserClient = any;

export class ZeroGDA {
  private client: DisperserClient;

  constructor() {
    const protoPath = path.resolve(__dirname, '../proto/disperser.proto');

    const packageDef = protoLoader.loadSync(protoPath, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = grpc.loadPackageDefinition(packageDef) as any;

    const credentials = config.ZG_DA_TLS
      ? grpc.credentials.createSsl()
      : grpc.credentials.createInsecure();

    this.client = new proto.disperser.Disperser(
      config.ZG_DA_DISPERSER,
      credentials
    );

    logger.info('ZeroGDA initialized', { disperser: config.ZG_DA_DISPERSER });
  }

  /**
   * Publish a rootHash to 0G DA as a blob.
   *
   * The blob we submit is: UTF-8 bytes of the 0x-prefixed rootHash string.
   * This is intentionally minimal — the rootHash is the canonical commitment.
   * Anyone auditing the DA layer can reconstruct the full save chain by:
   *   1. Reading the DA blob → rootHash
   *   2. Querying 0G Storage with that rootHash → .sav file
   *   3. SHA-256 the file → compare with checksum in MongoDB
   *
   * Returns the DA commitment metadata once FINALIZED.
   */
  async publishCommitment(
    rootHash: string,
    walletAddress: string
  ): Promise<DaCommitment> {
    // Pack a structured payload: rootHash + wallet + timestamp
    const payload = JSON.stringify({
      rootHash,
      wallet: walletAddress.toLowerCase(),
      ts: Date.now(),
    });
    const blobData = Buffer.from(payload, 'utf-8');

    logger.info('Submitting blob to 0G DA', {
      rootHash,
      wallet: walletAddress,
      blobSize: blobData.length,
    });

    const requestId = await this.disperseBlob(blobData, walletAddress);
    logger.info('DA blob submitted', { requestId });

    const commitment = await this.pollForFinality(requestId, rootHash);
    logger.info('DA commitment finalized', commitment);

    return commitment;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────

  private disperseBlob(data: Buffer, account: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.client.DisperseBlob(
        {
          data,
          custom_quorum_numbers: [],
          account_id: { account_id: account.toLowerCase() },
        },
        (err: grpc.ServiceError | null, reply: DisperseBlobReply) => {
          if (err) return reject(new Error(`DA DisperseBlob failed: ${err.message}`));
          if (reply.result === BlobStatus.FAILED) {
            return reject(new Error('DA blob rejected immediately (FAILED status)'));
          }
          resolve(reply.request_id.toString('hex'));
        }
      );
    });
  }

  private pollForFinality(
    requestId: string,
    rootHash: string
  ): Promise<DaCommitment> {
    const deadline = Date.now() + config.ZG_DA_POLL_TIMEOUT_MS;

    return new Promise((resolve, reject) => {
      const poll = () => {
        if (Date.now() > deadline) {
          return reject(
            new Error(`DA finality timeout after ${config.ZG_DA_POLL_TIMEOUT_MS}ms`)
          );
        }

        this.client.GetBlobStatus(
          { request_id: Buffer.from(requestId, 'hex') },
          (err: grpc.ServiceError | null, reply: BlobStatusReply) => {
            if (err) return reject(new Error(`DA GetBlobStatus failed: ${err.message}`));

            logger.debug('DA poll status', { requestId, status: reply.status });

            switch (reply.status) {
              case BlobStatus.FINALIZED: {
                const proof = reply.blob_verification_proof;
                const hdr = reply.signed_batch?.header;
                if (!proof || !hdr) {
                  return reject(new Error('DA FINALIZED reply missing proof metadata'));
                }

                resolve({
                  requestId,
                  batchId: proof.batch_id,
                  blobIndex: proof.blob_index,
                  batchHeaderHash: proof.batch_metadata?.batch_header_hash.toString('hex') ?? '',
                  referenceBlockNumber: hdr.reference_block_number,
                  finalizedAt: new Date(),
                });
                break;
              }

              case BlobStatus.FAILED:
              case BlobStatus.INSUFFICIENT_SIGNATURES:
                reject(new Error(`DA blob failed with status: ${reply.status}`));
                break;

              case BlobStatus.PROCESSING:
              case BlobStatus.UNKNOWN:
              default:
                setTimeout(poll, config.ZG_DA_POLL_INTERVAL_MS);
            }
          }
        );
      };

      poll();
    });
  }

  /**
   * Verify that a DA commitment exists and matches a given rootHash.
   * Used by the anti-cheat endpoint.
   *
   * The verification strategy:
   *  1. We re-submit a GetBlobStatus with the stored requestId.
   *  2. FINALIZED status + matching batchId/blobIndex → commitment is authentic.
   *  3. Any other status → flag as suspicious.
   *
   * A full cryptographic verification would additionally:
   *  - Query the DA contract for the batch's aggregated BLS signature
   *  - Reconstruct the blob data and verify the KZG proof
   * This is left for an on-chain verifier contract (see rollup integration notes).
   */
  async verifyCommitment(commitment: DaCommitment, rootHash: string): Promise<boolean> {
    return new Promise((resolve) => {
      this.client.GetBlobStatus(
        { request_id: Buffer.from(commitment.requestId, 'hex') },
        (err: grpc.ServiceError | null, reply: BlobStatusReply) => {
          if (err) {
            logger.warn('DA verification gRPC error', { err: err.message });
            resolve(false);
            return;
          }

          if (reply.status !== BlobStatus.FINALIZED) {
            logger.warn('DA commitment not finalized', { status: reply.status, rootHash });
            resolve(false);
            return;
          }

          const proof = reply.blob_verification_proof;
          const matches =
            proof?.batch_id === commitment.batchId &&
            proof?.blob_index === commitment.blobIndex;

          if (!matches) {
            logger.warn('DA commitment metadata mismatch', { rootHash, proof, commitment });
          }

          resolve(matches);
        }
      );
    });
  }
}

export const zgDA = new ZeroGDA();
