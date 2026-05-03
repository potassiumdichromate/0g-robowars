import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import mongoose from 'mongoose';
import * as fs from 'fs';
import * as path from 'path';

import { config } from './config';
import { logger } from './utils/logger';
import { globalRateLimiter } from './middleware/rateLimiter';
import { authRouter } from './routes/authRoutes';
import { saveRouter } from './routes/saveRoutes';
import { leaderboardRouter } from './routes/leaderboardRoutes';

const app = express();

// ── Security headers ───────────────────────────────────────────────────────────
app.use(helmet());
app.use(
  cors({
    origin: config.CORS_ORIGIN,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ── Compression + body parsing ─────────────────────────────────────────────────
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// ── Global rate limit ──────────────────────────────────────────────────────────
app.use(globalRateLimiter);

// ── Trust proxy (required for rate-limit accuracy behind nginx/LB) ─────────────
app.set('trust proxy', 1);

// ── Health check (unauthenticated) ─────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    version: '1.0.0',
    network: {
      storage: config.ZG_INDEXER_RPC,
      da: config.ZG_DA_DISPERSER,
    },
    uptime: process.uptime(),
  });
});

// ── Routes ─────────────────────────────────────────────────────────────────────
app.use('/auth', authRouter);
app.use('/save', saveRouter);
app.use('/leaderboard', leaderboardRouter);

// ── 404 handler ────────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ───────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Startup ─────────────────────────────────────────────────────────────────────
async function start(): Promise<void> {
  // Ensure temp directory exists
  fs.mkdirSync(path.join(process.cwd(), 'tmp'), { recursive: true });

  // Connect to MongoDB
  await mongoose.connect(config.MONGO_URI, {
    serverSelectionTimeoutMS: 5000,
  });
  logger.info('MongoDB connected', { uri: config.MONGO_URI });

  // Start HTTP server
  app.listen(config.PORT, () => {
    logger.info(`0G RoboWars backend running on port ${config.PORT}`, {
      env: config.NODE_ENV,
      storage: config.ZG_INDEXER_RPC,
      da: config.ZG_DA_DISPERSER,
    });
  });
}

start().catch((err) => {
  logger.error('Startup failed', { err });
  process.exit(1);
});
