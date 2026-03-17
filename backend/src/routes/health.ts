import { Request, Response, Router } from 'express';
import { getPool } from '../db';

const router = Router();

// Liveness — always 200 if the process is running
router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env['npm_package_version'] ?? '1.0.0',
  });
});

// Readiness — 200 only when DB is reachable
router.get('/ready', async (_req: Request, res: Response): Promise<void> => {
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1 AS ping');
    res.json({ status: 'ready', db: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    res.status(503).json({ status: 'unavailable', db: 'error', error: message, timestamp: new Date().toISOString() });
  }
});

export default router;
