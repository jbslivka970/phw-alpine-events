import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

dotenv.config();

import { loadConfig } from './config';
import apiRouter from './routes/index';
import { errorHandler, notFoundHandler } from './middleware/error';

// Validate environment variables at startup (throws if any are missing)
let port: number;
try {
  const cfg = loadConfig();
  port = cfg.port;
} catch (err) {
  console.error('Configuration error:', (err as Error).message);
  // In production fail fast; in development allow startup for diagnostics.
  if (process.env['NODE_ENV'] === 'production') {
    process.exit(1);
  }
  port = parseInt(process.env['PORT'] ?? '3001', 10);
}

const app = express();


app.use(helmet());
app.use(cors());
app.use(express.json());

// ── Root convenience endpoint ────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ message: 'PHW Alpine Events API', apiBase: '/api/v1' });
});

// ── Versioned API namespace ──────────────────────────────────────────────────
app.use('/api/v1', apiRouter);

// ── 404 handler (must come after all routes) ────────────────────────────────
app.use(notFoundHandler);

// ── Centralized error handler (must be last) ────────────────────────────────
app.use(errorHandler);

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Server running on port ${port} (${process.env['NODE_ENV'] ?? 'development'})`);
});

export default app;