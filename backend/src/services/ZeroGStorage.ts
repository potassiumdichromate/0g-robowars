/**
 * ZeroGStorage — wraps the 0G Storage TypeScript SDK.
 *
 * Responsibilities:
 *  - Upload binary .sav files to 0G decentralized storage
 *  - Return the Merkle rootHash that permanently identifies the blob
 *  - Download a blob by rootHash with Merkle proof verification
 *
 * Why 0G Storage over alternatives:
 *  - vs IPFS: 0G provides economic guarantees via on-chain payment + replication.
 *    IPFS pins are voluntary and disappear when nodes go offline.
 *  - vs S3: 0G is permissionless and censorship-resistant.
 *    S3 is a centralized point of failure owned by AWS.
 *  - 0G's Merkle rootHash is deterministic — the same file always produces
 *    the same hash, enabling content-addressed deduplication.
 */

import { ZgFile, Indexer } from '@0gfoundation/0g-storage-ts-sdk';
import { ethers } from 'ethers';
import * as fs from 'fs';
import { config } from '../config';
import { logger } from '../utils/logger';

interface UploadResult {
  rootHash: string;    // 0G Merkle root — the permanent content identifier
  txHash: string;      // EVM transaction hash anchoring the submission
}

export class ZeroGStorage {
  private readonly indexer: Indexer;
  private readonly signer: ethers.Wallet;

  constructor() {
    const provider = new ethers.JsonRpcProvider(config.ZG_RPC_URL);
    // Uses the dedicated storage key (ZG_STORAGE_PRIVATE_KEY) so the storage
    // signer's blast radius is limited to Flow contract transactions only.
    // Falls back to ZG_PRIVATE_KEY if no dedicated key is configured.
    this.signer = new ethers.Wallet(config.ZG_STORAGE_PRIVATE_KEY, provider);
    this.indexer = new Indexer(config.ZG_INDEXER_RPC);

    logger.info('ZeroGStorage initialized', {
      rpc: config.ZG_RPC_URL,
      indexer: config.ZG_INDEXER_RPC,
      storageWallet: this.signer.address,
      usingDedicatedKey: !!process.env['ZG_STORAGE_PRIVATE_KEY'],
    });
  }

  /**
   * Upload a .sav file to 0G Storage.
   *
   * The SDK:
   *  1. Computes the Merkle tree over 256-byte segments of the file.
   *  2. Submits the tree root to the 0G Flow contract on-chain (EVM tx).
   *  3. Propagates segments to storage nodes selected by the indexer.
   *
   * Returns the rootHash — this is the canonical identifier used by every
   * other part of the system (DB, DA commitment, Unreal download).
   */
  async upload(filePath: string): Promise<UploadResult> {
    logger.info('Uploading to 0G Storage', { filePath });

    const file = await ZgFile.fromFilePath(filePath);

    try {
      const [, treeErr] = await file.merkleTree();
      if (treeErr) throw new Error(`Merkle tree error: ${treeErr}`);

      const [tx, uploadErr] = await this.indexer.upload(
        file,
        config.ZG_RPC_URL,
        this.signer
      );

      if (uploadErr) throw new Error(`Upload error: ${uploadErr}`);

      // The SDK returns either a single tx (small file) or array (split upload)
      if ('rootHash' in tx) {
        logger.info('0G Storage upload complete', { rootHash: tx.rootHash });
        return { rootHash: tx.rootHash as string, txHash: tx.txHash as string };
      }

      // Splitable upload: multiple chunks — use first root as canonical identifier
      const rootHashes = tx.rootHashes as string[];
      const txHashes = tx.txHashes as string[];
      logger.info('0G Storage split upload complete', { roots: rootHashes.length });
      return { rootHash: rootHashes[0], txHash: txHashes[0] };
    } finally {
      await file.close();
    }
  }

  /**
   * Download a .sav file from 0G Storage by rootHash.
   *
   * withProof=true forces the storage node to include a Merkle proof
   * for each segment. The SDK verifies every proof locally — if any
   * segment is tampered, the download throws before writing to disk.
   *
   * This is the first layer of anti-tamper protection:
   * the file you receive is cryptographically guaranteed to match the
   * rootHash you requested.
   */
  async download(rootHash: string, outputPath: string): Promise<void> {
    logger.info('Downloading from 0G Storage', { rootHash, outputPath });

    const err = await this.indexer.download(
      rootHash,
      outputPath,
      true  // withProof — always verify
    );

    if (err) throw new Error(`Download error: ${err}`);

    logger.info('0G Storage download complete', { rootHash, outputPath });
  }

  /**
   * Verify that a rootHash stored in our DB still resolves to the
   * same bytes as the provided checksum.  Used by the anti-cheat
   * endpoint to confirm saves have not been substituted on-chain.
   */
  async verifyIntegrity(
    rootHash: string,
    expectedChecksum: string,
    tmpPath: string
  ): Promise<boolean> {
    await this.download(rootHash, tmpPath);

    const crypto = await import('crypto');
    const data = fs.readFileSync(tmpPath);
    const actual = crypto.createHash('sha256').update(data).digest('hex');
    fs.unlinkSync(tmpPath);

    return actual === expectedChecksum;
  }
}

export const zgStorage = new ZeroGStorage();
