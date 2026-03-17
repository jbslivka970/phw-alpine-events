import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

dotenv.config();

import memberRoutes from './routes/members';
import groupRoutes from './routes/groups';

const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (_req: Request, res: Response) => {
  res.json({ message: 'PHW Alpine Events API', version: 'v1' });
});

// API v1 routes
app.use('/api/v1/members', memberRoutes);
app.use('/api/v1/groups',  groupRoutes);

// Global error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: Error & { statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.statusCode ?? 500;
  const message = status < 500 ? err.message : 'Internal server error';
  if (status >= 500) {
    console.error(err);
  }
  res.status(status).json({ error: message });
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

export default app;