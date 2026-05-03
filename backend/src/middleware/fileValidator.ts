import { Request, Response, NextFunction } from 'express';
import * as crypto from 'crypto';
import * as fs from 'fs';
import multer from 'multer';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../utils/logger';

// ── Multer disk storage — temp dir for 0G SDK file access ─────────────────────
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const tmpDir = path.join(process.cwd(), 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    cb(null, tmpDir);
  },
  filename: (_req, file, cb) => {
    // Sanitise the original filename, append random suffix to prevent collisions
    const safe = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}_${safe}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: config.MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    // Accept only Unreal .sav files by extension and MIME type
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.sav') {
      cb(new Error('Only .sav files are accepted'));
      return;
    }
    cb(null, true);
  },
});

/**
 * Post-multer validation middleware.
 *
 * Validates:
 *  - File was actually attached
 *  - File size is within bounds (double-check; multer can be bypassed)
 *  - Unreal .sav magic bytes: 0xGVAS (GVAS header, little-endian)
 *  - Computes SHA-256 checksum and attaches to req for downstream use
 *
 * The magic byte check ensures we never store arbitrary binary data
 * disguised as a save file, reducing the attack surface on 0G Storage.
 */
export function validateSavFile(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (!req.file) {
    res.status(400).json({ error: 'No file attached. Field name must be "savefile".' });
    return;
  }

  const { path: filePath, size } = req.file;

  if (size > config.MAX_FILE_SIZE_BYTES) {
    fs.unlinkSync(filePath);
    res.status(413).json({ error: `File too large. Max ${config.MAX_FILE_SIZE_BYTES / 1024 / 1024} MB.` });
    return;
  }

  // Read the first 4 bytes to validate Unreal GVAS magic
  const fd = fs.openSync(filePath, 'r');
  const magic = Buffer.alloc(4);
  fs.readSync(fd, magic, 0, 4, 0);
  fs.closeSync(fd);

  // Unreal Engine save file magic: GVAS (0x47 0x56 0x41 0x53)
  const GVAS_MAGIC = Buffer.from([0x47, 0x56, 0x41, 0x53]);
  if (!magic.equals(GVAS_MAGIC)) {
    fs.unlinkSync(filePath);
    logger.warn('Invalid GVAS magic bytes', {
      received: magic.toString('hex'),
      wallet: req.walletAddress,
    });
    res.status(400).json({ error: 'Invalid .sav file: missing Unreal GVAS header.' });
    return;
  }

  // Compute SHA-256 of the full file
  const data = fs.readFileSync(filePath);
  const checksum = crypto.createHash('sha256').update(data).digest('hex');

  // Attach to request for use in the route handler
  req.file.checksum = checksum;
  logger.debug('File validated', { size, checksum, wallet: req.walletAddress });

  next();
}

// Extend Multer's File type to carry our computed checksum
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Multer {
      interface File {
        checksum: string;
      }
    }
  }
}
