import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import config from './config';
import healthRouter from './routes/health';
import eventsRouter from './routes/events';
import membersRouter from './routes/members';
import adminRouter from './routes/admin';
import { errorHandler } from './middleware/errorHandler';

const app = express();
const port = config.port;

// ── Core middleware ──────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json());

// ── Public routes ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.json({ message: 'PHW Alpine Events API' });
});
app.use('/health', healthRouter);

// ── Protected API routes ─────────────────────────────────────────────────────
// Authentication and role checks are applied inside each router.
app.use('/api/events', eventsRouter);
app.use('/api/members', membersRouter);
app.use('/api/admin', adminRouter);

// ── Global error handler ─────────────────────────────────────────────────────
app.use(errorHandler);

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(port, () => {
  console.log(`Server running on port ${port} [${config.nodeEnv}]`);
});

export default app;