import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

dotenv.config();

import { loadServerConfig } from './config';
import { errorHandler, notFoundHandler } from './middleware/error';
import apiRouter from './routes';

const app = express();
const { corsOrigin, port, nodeEnv } = loadServerConfig();

// Middleware
app.use(helmet());
app.use(cors(corsOrigin ? { origin: corsOrigin } : undefined));
app.use(express.json());

// Basic route
app.get('/', (_req, res) => {
  res.json({ message: 'PHW Alpine Events API', apiBase: '/api/v1' });
});

app.use('/api/v1', apiRouter);

app.use(notFoundHandler);

app.use(errorHandler);

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port} (${nodeEnv})`);
});

export default app;