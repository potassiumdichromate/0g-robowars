import { ethers } from 'ethers';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { Nonce } from '../models/Nonce';
import { config } from '../config';
import { logger } from '../utils/logger';

export interface JwtPayload {
  walletAddress: string;
  iat: number;
  exp: number;
}

export class AuthService {
  /**
   * Generate a cryptographically random nonce and persist it.
   *
   * The nonce is:
   *  - UUID v4 (128 bits of entropy)
   *  - Single-use (used=true after verification)
   *  - TTL-indexed in MongoDB (auto-deleted after NONCE_EXPIRY_MS)
   *
   * The client must sign exactly this message string. We embed the
   * wallet address to prevent cross-wallet replay attacks.
   */
  async generateNonce(walletAddress: string): Promise<string> {
    const normalized = walletAddress.toLowerCase();

    // Invalidate any prior unused nonce for this wallet
    await Nonce.deleteMany({ walletAddress: normalized, used: false });

    const nonce = uuidv4();
    const expiresAt = new Date(Date.now() + config.NONCE_EXPIRY_MS);

    await Nonce.create({ walletAddress: normalized, nonce, expiresAt });

    logger.debug('Nonce generated', { wallet: normalized });
    return nonce;
  }

  /**
   * Build the canonical message the client must sign.
   *
   * We use a human-readable prefix (EIP-4361-inspired) so that wallets
   * display the intent clearly rather than a raw hex blob.
   */
  buildSignMessage(walletAddress: string, nonce: string): string {
    return [
      '0G RoboWars — Sign to authenticate.',
      `Wallet: ${walletAddress.toLowerCase()}`,
      `Nonce: ${nonce}`,
      'This request will not trigger a blockchain transaction or cost any gas.',
    ].join('\n');
  }

  /**
   * Verify the ECDSA signature and issue a JWT on success.
   *
   * Steps:
   *  1. Fetch nonce from DB — reject if missing/expired/used.
   *  2. Recover the signer address from the signature.
   *  3. Confirm recovered address matches claimed wallet.
   *  4. Mark nonce as used (anti-replay).
   *  5. Issue JWT with short expiry.
   */
  async verifySignature(
    walletAddress: string,
    signature: string
  ): Promise<string> {
    const normalized = walletAddress.toLowerCase();

    const nonceDoc = await Nonce.findOne({
      walletAddress: normalized,
      used: false,
      expiresAt: { $gt: new Date() },
    });

    if (!nonceDoc) {
      throw new Error('Nonce not found, expired, or already used');
    }

    const message = this.buildSignMessage(walletAddress, nonceDoc.nonce);

    let recovered: string;
    try {
      recovered = ethers.verifyMessage(message, signature).toLowerCase();
    } catch {
      throw new Error('Invalid signature format');
    }

    if (recovered !== normalized) {
      logger.warn('Signature mismatch', { claimed: normalized, recovered });
      throw new Error('Signature does not match wallet address');
    }

    // Invalidate nonce — cannot be reused even if JWT is stolen
    nonceDoc.used = true;
    await nonceDoc.save();

    const token = jwt.sign(
      { walletAddress: normalized },
      config.JWT_SECRET,
      { expiresIn: config.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'] }
    );

    logger.info('Auth successful', { wallet: normalized });
    return token;
  }

  /**
   * Decode and verify a JWT.  Throws if expired or tampered.
   */
  verifyToken(token: string): JwtPayload {
    return jwt.verify(token, config.JWT_SECRET) as JwtPayload;
  }
}

export const authService = new AuthService();
