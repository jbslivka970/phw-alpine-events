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
import { runReminderJob } from './jobs/reminderJob';
import { runTavfExpiryJob } from './jobs/tavfExpiryJob';
import { runWaitlistLifecycleJob } from './jobs/waitlistLifecycleJob';
import { runRetentionJob } from './jobs/retentionJob';
import apiRouter from './routes';

const app = express();
const { corsOrigin, port, nodeEnv } = loadServerConfig();
app.set('trust proxy', nodeEnv === 'production' ? 1 : false);
const allowedOrigins = (corsOrigin ?? '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter((value) => value.length > 0);
const corsOptions = allowedOrigins.length
  ? {
    origin: (
      requestOrigin: string | undefined,
      callback: (error: Error | null, allow?: boolean | string) => void,
    ) => {
      if (!requestOrigin) {
        callback(null, false);
        return;
      }

      const normalizedOrigin = requestOrigin.replace(/\/$/, '');
      if (allowedOrigins.includes(normalizedOrigin)) {
        callback(null, normalizedOrigin);
        return;
      }

      callback(new Error(`Not allowed by CORS: ${requestOrigin}`));
    },
  }
  : undefined;

// Middleware
app.use(helmet());
app.use(cors(corsOptions));
app.use(express.json());

// Basic route
app.get('/', (_req, res) => {
  res.json({ message: 'PHW Alpine Events API', apiBase: '/api/v1' });
});

app.use('/api/v1', apiRouter);

app.use(notFoundHandler);

app.use(errorHandler);

let reminderTimer: NodeJS.Timeout | undefined;
let tavfExpiryTimer: NodeJS.Timeout | undefined;
let waitlistLifecycleTimer: NodeJS.Timeout | undefined;
let retentionTimer: NodeJS.Timeout | undefined;

function parseMs(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function scheduleJobs(): void {
  const jobsEnabled = parseBool(process.env['JOBS_ENABLED'], nodeEnv !== 'test');
  if (!jobsEnabled) {
    console.log('[scheduler] Jobs disabled via JOBS_ENABLED');
    return;
  }

  const reminderIntervalMs = parseMs(process.env['REMINDER_JOB_INTERVAL_MS'], 60 * 60 * 1000);
  const reminderLookAheadHours = parseMs(process.env['REMINDER_LOOKAHEAD_HOURS'], 48);
  const tavfExpiryIntervalMs = parseMs(process.env['TAVF_EXPIRY_JOB_INTERVAL_MS'], 24 * 60 * 60 * 1000);
  const waitlistLifecycleIntervalMs = parseMs(process.env['WAITLIST_JOB_INTERVAL_MS'], 15 * 60 * 1000);
  const retentionEnabled = parseBool(process.env['RETENTION_JOB_ENABLED'], false);
  const retentionIntervalMs = parseMs(process.env['RETENTION_JOB_INTERVAL_MS'], 24 * 60 * 60 * 1000);

  const runReminder = async (): Promise<void> => {
    try {
      await runReminderJob(reminderLookAheadHours);
    } catch (error) {
      console.error('[scheduler] reminder job failed', error);
    }
  };

  const runTavfExpiry = async (): Promise<void> => {
    try {
      await runTavfExpiryJob();
    } catch (error) {
      console.error('[scheduler] tavf expiry job failed', error);
    }
  };

  const runWaitlistLifecycle = async (): Promise<void> => {
    try {
      await runWaitlistLifecycleJob();
    } catch (error) {
      console.error('[scheduler] waitlist lifecycle job failed', error);
    }
  };

  const runRetention = async (): Promise<void> => {
    try {
      await runRetentionJob();
    } catch (error) {
      console.error('[scheduler] retention job failed', error);
    }
  };

  void runReminder();
  void runTavfExpiry();
  void runWaitlistLifecycle();
  if (retentionEnabled) {
    void runRetention();
  }

  reminderTimer = setInterval(() => {
    void runReminder();
  }, reminderIntervalMs);
  tavfExpiryTimer = setInterval(() => {
    void runTavfExpiry();
  }, tavfExpiryIntervalMs);
  waitlistLifecycleTimer = setInterval(() => {
    void runWaitlistLifecycle();
  }, waitlistLifecycleIntervalMs);
  if (retentionEnabled) {
    retentionTimer = setInterval(() => {
      void runRetention();
    }, retentionIntervalMs);
  }

  console.log(JSON.stringify({
    level: 'info',
    event: 'jobs_scheduled',
    reminderIntervalMs,
    reminderLookAheadHours,
    tavfExpiryIntervalMs,
    waitlistLifecycleIntervalMs,
    retentionEnabled,
    retentionIntervalMs,
    timestamp: new Date().toISOString(),
  }));
}

scheduleJobs();

function clearSchedulers(): void {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = undefined;
  }
  if (tavfExpiryTimer) {
    clearInterval(tavfExpiryTimer);
    tavfExpiryTimer = undefined;
  }
  if (waitlistLifecycleTimer) {
    clearInterval(waitlistLifecycleTimer);
    waitlistLifecycleTimer = undefined;
  }
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = undefined;
  }
}

process.on('SIGINT', clearSchedulers);
process.on('SIGTERM', clearSchedulers);

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
