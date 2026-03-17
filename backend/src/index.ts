import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';

dotenv.config();

// Application Insights — activate before any imports if APPINSIGHTS_KEY is set
const aiKey = process.env['APPINSIGHTS_INSTRUMENTATIONKEY'] ?? process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'];
if (aiKey) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const appInsights = require('applicationinsights') as {
      setup(key: string): { setAutoCollectConsole(v: boolean, b: boolean): unknown };
      start(): void;
    };
    appInsights.setup(aiKey).setAutoCollectConsole(true, true);
    appInsights.start();
    console.log('[startup] Application Insights activated');
  } catch {
    console.warn('[startup] applicationinsights package not installed — telemetry disabled');
  }
}

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
  console.log(JSON.stringify({
    level: 'info',
    event: 'startup',
    port,
    env: nodeEnv,
    timestamp: new Date().toISOString(),
  }));
});

export default app;
