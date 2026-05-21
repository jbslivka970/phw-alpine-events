import { NextFunction, Request, Response, Router } from 'express';
import authenticate from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimiter';
import { requireAnyAuthenticatedRole } from '../middleware/rbac';
import { listPrograms, normalizeStateNameInput } from '../services/programCatalogService';

const router = Router();

router.get('/', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawState = req.query.state;
    const stateName = rawState === undefined ? null : normalizeStateNameInput(rawState);
    if (rawState !== undefined && !stateName) {
      res.status(400).json({ error: 'state must be 100 characters or less when provided.' });
      return;
    }

    const programs = await listPrograms({
      stateName,
      includeInactive: false,
    });

    res.json(programs);
  } catch (error) {
    next(error);
  }
});

export default router;
