import { Router } from 'express';
import adminRouter from './admin';
import calendarRouter from './calendar';
import eventsRouter from './events';
import groupsRouter from './groups';
import healthRouter from './health';
import importRouter from './import';
import membersRouter from './members';
import reportsRouter from './reports';
import tavfRouter from './tavf';

const router = Router();

router.use('/health', healthRouter);
router.use('/admin', adminRouter);
router.use('/calendar', calendarRouter);
router.use('/events', eventsRouter);
router.use('/members', membersRouter);
router.use('/groups', groupsRouter);
router.use('/import', importRouter);
router.use('/reports', reportsRouter);
router.use('/tavf', tavfRouter);

export default router;