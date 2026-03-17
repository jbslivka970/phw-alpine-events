import { Router } from 'express';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/rbac';

const router = Router();

router.use(apiLimiter, authenticate, requireAdmin);

router.get('/users', (_req, res) => {
  res.json({ data: [], message: 'Admin users endpoint - implementation pending' });
});

router.post('/import', writeLimiter, (_req, res) => {
  res.status(202).json({ message: 'Import endpoint - implementation pending' });
});

export default router;