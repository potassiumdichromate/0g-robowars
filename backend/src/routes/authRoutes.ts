import { Router, Request, Response } from 'express';
import { ethers } from 'ethers';
import { authService } from '../services/AuthService';
import { authRateLimiter } from '../middleware/rateLimiter';
import { logger } from '../utils/logger';

export const authRouter = Router();

/**
 * POST /auth/nonce
 *
 * Step 1 of wallet authentication.
 * Returns a single-use nonce the client must sign with their private key.
 *
 * Body: { walletAddress: string }
 */
authRouter.post('/nonce', authRateLimiter, async (req: Request, res: Response) => {
  const { walletAddress } = req.body as { walletAddress?: string };

  if (!walletAddress) {
    res.status(400).json({ error: 'walletAddress is required' });
    return;
  }

  // Validate the address is a valid EVM address
  if (!ethers.isAddress(walletAddress)) {
    res.status(400).json({ error: 'Invalid Ethereum address' });
    return;
  }

  try {
    const nonce = await authService.generateNonce(walletAddress);
    const message = authService.buildSignMessage(walletAddress, nonce);

    res.json({
      nonce,
      message,                       // Pre-built message to sign
      expiresInMs: 300_000,          // 5 minutes
    });
  } catch (err) {
    logger.error('Nonce generation failed', { err, walletAddress });
    res.status(500).json({ error: 'Failed to generate nonce' });
  }
});

/**
 * POST /auth/verify
 *
 * Step 2 of wallet authentication.
 * Client submits the signed message; we verify and return a JWT.
 *
 * Body: { walletAddress: string, signature: string }
 */
authRouter.post('/verify', authRateLimiter, async (req: Request, res: Response) => {
  const { walletAddress, signature } = req.body as {
    walletAddress?: string;
    signature?: string;
  };

  if (!walletAddress || !signature) {
    res.status(400).json({ error: 'walletAddress and signature are required' });
    return;
  }

  if (!ethers.isAddress(walletAddress)) {
    res.status(400).json({ error: 'Invalid Ethereum address' });
    return;
  }

  try {
    const token = await authService.verifySignature(walletAddress, signature);

    res.json({
      token,
      walletAddress: walletAddress.toLowerCase(),
      expiresIn: '24h',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Verification failed';
    logger.warn('Auth verify failed', { message, walletAddress });
    res.status(401).json({ error: message });
  }
});
