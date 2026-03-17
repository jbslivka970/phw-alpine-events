import { Router } from 'express';

const router = Router();

/** GET /health — public liveness check */
router.get('/', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

export default router;
