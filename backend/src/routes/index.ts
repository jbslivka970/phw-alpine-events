import { Router } from 'express';
import adminRouter from './admin';
import eventsRouter from './events';
import groupsRouter from './groups';
import healthRouter from './health';
import membersRouter from './members';

const router = Router();

router.use('/health', healthRouter);
router.use('/admin', adminRouter);
router.use('/events', eventsRouter);
router.use('/members', membersRouter);
router.use('/groups', groupsRouter);

export default router;