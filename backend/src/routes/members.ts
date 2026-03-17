import { Router } from 'express';
import authenticate from '../middleware/auth';
import { requireAdmin, requireAnyAuthenticatedRole } from '../middleware/rbac';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';

const router = Router();

/** GET /api/members — any authenticated user */
router.get('/', apiLimiter, authenticate, requireAnyAuthenticatedRole, (_req, res) => {
  // TODO: query database for members
  res.json({ data: [], message: 'Members endpoint – implementation pending' });
});

/** GET /api/members/:id — any authenticated user */
router.get('/:id', apiLimiter, authenticate, requireAnyAuthenticatedRole, (req, res) => {
  res.json({ id: req.params.id, message: 'Get member endpoint – implementation pending' });
});

/** POST /api/members — ADMIN only */
router.post('/', writeLimiter, authenticate, requireAdmin, (_req, res) => {
  res.status(201).json({ message: 'Create member endpoint – implementation pending' });
});

/** PUT /api/members/:id — ADMIN only */
router.put('/:id', writeLimiter, authenticate, requireAdmin, (req, res) => {
  res.json({ id: req.params.id, message: 'Update member endpoint – implementation pending' });
});

/** DELETE /api/members/:id — ADMIN only */
router.delete('/:id', writeLimiter, authenticate, requireAdmin, (req, res) => {
  res.json({ id: req.params.id, message: 'Delete member endpoint – implementation pending' });
});

export default router;
