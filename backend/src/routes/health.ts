import { Request, Response, Router } from 'express';
import { getPool } from '../db';
import { loadAcsConfig, loadAuthConfig } from '../config';
import { getNotificationRuntimeStatus } from '../services/notifications';

const router = Router();

const REQUIRED_DB_ENV_VARS = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'] as const;
const REQUIRED_AUTH_ENV_VARS = ['AZURE_AD_B2C_TENANT_NAME', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID'] as const;

function missingEnvVars(names: readonly string[]): string[] {
  return names.filter((name) => !process.env[name]);
}

function missingAuthVars(): string[] {
  const hasClientId = Boolean(process.env['AZURE_CLIENT_ID']);
  const hasExplicitExternalId = Boolean(process.env['AZURE_AUTH_ISSUER'] && process.env['AZURE_AUTH_JWKS_URI']);
  const hasLegacyDiscovery = Boolean(
    (process.env['AZURE_EXTERNAL_TENANT_NAME'] && process.env['AZURE_EXTERNAL_TENANT_ID'])
      || (process.env['AZURE_AD_B2C_TENANT_NAME'] && process.env['AZURE_TENANT_ID'])
  );

  if (hasClientId && (hasExplicitExternalId || hasLegacyDiscovery)) {
    return [];
  }

  const missing: string[] = [];

  if (!hasClientId) {
    missing.push('AZURE_CLIENT_ID');
  }

  if (!hasExplicitExternalId && !hasLegacyDiscovery) {
    missing.push('AZURE_AUTH_ISSUER_OR_TENANT_DISCOVERY_CONFIG');
  }

  return missing;
}

// Liveness — always 200 if the process is running
router.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env['npm_package_version'] ?? '1.0.0',
  });
});

// Readiness — 200 only when DB is reachable
router.get('/ready', async (_req: Request, res: Response): Promise<void> => {
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1 AS ping');
    res.json({ status: 'ready', db: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    res.status(503).json({ status: 'unavailable', db: 'error', error: message, timestamp: new Date().toISOString() });
  }
});

// Startup diagnostics — reports configuration health without exposing secrets
router.get('/startup', (_req: Request, res: Response) => {
  const authConfig = loadAuthConfig();
  const acsConfig = loadAcsConfig();
  const notificationStatus = getNotificationRuntimeStatus();
  const telemetryConfigured = Boolean(
    process.env['APPINSIGHTS_INSTRUMENTATIONKEY'] || process.env['APPLICATIONINSIGHTS_CONNECTION_STRING']
  );
  const dbMissing = missingEnvVars(REQUIRED_DB_ENV_VARS);
  const authMissing = missingAuthVars();
  const isProd = process.env['NODE_ENV'] === 'production';
  const strictNotificationFailure = notificationStatus.strictModeEnabled && notificationStatus.mode !== 'real';

  const summary = {
    status: dbMissing.length === 0 && !strictNotificationFailure ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    runtime: {
      nodeEnv: process.env['NODE_ENV'] ?? 'development',
      nodeVersion: process.version,
      portMode: Number.isNaN(Number.parseInt(process.env['PORT'] ?? '', 10)) ? 'pipe-or-string' : 'numeric',
    },
    checks: {
      dbEnvConfigured: dbMissing.length === 0,
      authConfigured: authConfig.isConfigured,
      notificationsConfigured: acsConfig.isConfigured,
      notificationMode: notificationStatus.mode,
      notificationStrictModeEnabled: notificationStatus.strictModeEnabled,
      emailNotificationChannel: notificationStatus.emailServiceMode,
      smsNotificationChannel: notificationStatus.smsServiceMode,
      telemetryConfigured,
    },
    missing: {
      db: dbMissing,
      auth: authMissing,
      optional: [
        ...(!process.env['ACS_CONNECTION_STRING'] ? ['ACS_CONNECTION_STRING'] : []),
        ...(process.env['ACS_CONNECTION_STRING'] && !process.env['ACS_EMAIL_FROM'] ? ['ACS_EMAIL_FROM'] : []),
        ...(!telemetryConfigured ? ['APPINSIGHTS_INSTRUMENTATIONKEY_OR_APPLICATIONINSIGHTS_CONNECTION_STRING'] : []),
      ],
      notifications: notificationStatus.reasons,
    },
  };

  if (isProd && (dbMissing.length > 0 || strictNotificationFailure)) {
    res.status(503).json(summary);
    return;
  }

  res.json(summary);
});

export default router;
