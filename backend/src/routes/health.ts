import { Router, Request, Response } from 'express';

const router = Router();

/**
 * GET /api/v1/health
 * Lightweight liveness probe.
 */
router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env['npm_package_version'] ?? '1.0.0',
  });
});

/**
 * GET /api/v1/health/ready
 * Readiness probe – can be extended with DB connection checks.
 */
router.get('/ready', (_req: Request, res: Response) => {
  res.json({
    status: 'ready',
    timestamp: new Date().toISOString(),
  });
});

export default router;
