import rateLimit from 'express-rate-limit';

// ── Global limiter — applied to every route ─────────────────────────────────────
export const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// ── Auth endpoint — tighter window to resist brute-force ───────────────────────
export const authRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,   // 5 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    (req.body?.walletAddress ?? req.ip ?? 'unknown').toLowerCase(),
  message: { error: 'Too many auth attempts. Wait 5 minutes.' },
});

// ── Upload limiter — prevents spam/DoS on storage layer ───────────────────────
export const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.walletAddress ?? req.ip ?? 'unknown',
  message: { error: 'Upload rate limit exceeded. Max 5 saves per minute.' },
});
