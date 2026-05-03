import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/AuthService';
import { logger } from '../utils/logger';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      walletAddress: string;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const payload = authService.verifyToken(token);
    req.walletAddress = payload.walletAddress;
    next();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'JWT verification failed';
    logger.warn('Auth middleware rejected request', { message });
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * Verify the request wallet matches the resource owner.
 * Pass the owner address (from DB) after querying the resource.
 */
export function assertOwner(
  req: Request,
  res: Response,
  ownerAddress: string
): boolean {
  if (req.walletAddress !== ownerAddress.toLowerCase()) {
    res.status(403).json({ error: 'Access denied: not the resource owner' });
    return false;
  }
  return true;
}
