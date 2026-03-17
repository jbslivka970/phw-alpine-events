import { Router } from 'express';
import authenticate from '../middleware/auth';
import { requireAdmin } from '../middleware/rbac';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';

const router = Router();

/** All /api/admin routes require ADMIN role */
router.use(apiLimiter, authenticate, requireAdmin);

/** GET /api/admin/users — list system users (ADMIN only) */
router.get('/users', (_req, res) => {
  // TODO: query database for users
  res.json({ data: [], message: 'Admin users endpoint – implementation pending' });
});

/** POST /api/admin/import — trigger member import (ADMIN only) */
router.post('/import', writeLimiter, (_req, res) => {
  res.status(202).json({ message: 'Import endpoint – implementation pending' });
});

export default router;
