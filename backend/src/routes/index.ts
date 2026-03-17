import { Router } from 'express';
import healthRouter from './health';

const router = Router();

/**
 * /api/v1/health
 */
router.use('/health', healthRouter);

/*
 * Future route modules are mounted here, e.g.:
 *   import membersRouter from './members';
 *   router.use('/members', membersRouter);
 */

export default router;
