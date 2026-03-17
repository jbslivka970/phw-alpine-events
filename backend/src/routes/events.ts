import { Router } from 'express';
import authenticate from '../middleware/auth';
import { requireAnyAuthenticatedRole, requireEventCreatorOrAdmin } from '../middleware/rbac';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';

const router = Router();

/** GET /api/events — any authenticated user */
router.get('/', apiLimiter, authenticate, requireAnyAuthenticatedRole, (_req, res) => {
  // TODO: query database for events
  res.json({ data: [], message: 'Events endpoint – implementation pending' });
});

/** POST /api/events — ADMIN or EVENT_CREATOR */
router.post('/', writeLimiter, authenticate, requireEventCreatorOrAdmin, (_req, res) => {
  // TODO: create event in database
  res.status(201).json({ message: 'Create event endpoint – implementation pending' });
});

/** GET /api/events/:id — any authenticated user */
router.get('/:id', apiLimiter, authenticate, requireAnyAuthenticatedRole, (req, res) => {
  // TODO: fetch event by id
  res.json({ id: req.params.id, message: 'Get event endpoint – implementation pending' });
});

/** PUT /api/events/:id — ADMIN or EVENT_CREATOR */
router.put('/:id', writeLimiter, authenticate, requireEventCreatorOrAdmin, (req, res) => {
  // TODO: update event by id
  res.json({ id: req.params.id, message: 'Update event endpoint – implementation pending' });
});

/** DELETE /api/events/:id — ADMIN or EVENT_CREATOR */
router.delete('/:id', writeLimiter, authenticate, requireEventCreatorOrAdmin, (req, res) => {
  // TODO: delete event by id
  res.json({ id: req.params.id, message: 'Delete event endpoint – implementation pending' });
});

export default router;
