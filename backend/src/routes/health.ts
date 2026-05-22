import { Request, Response, Router } from 'express';
import { ManagedIdentityCredential } from '@azure/identity';
import fs from 'fs';
import path from 'path';
import { getPool } from '../db';
import { apiLimiter } from '../middleware/rateLimiter';
import { loadAcsConfig, loadAuthConfig, loadTelnyxSmsConfig, loadTwilioSmsConfig } from '../config';
import { getAiInviteRuntimeStatus } from '../services/aiInviteService';
import { getNotificationRuntimeStatus } from '../services/notifications';
import { getShortLivedCacheRuntimeStatus, runShortLivedCacheProbe } from '../services/shortLivedCache';

const router = Router();

const REQUIRED_DB_ENV_VARS = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'] as const;
const REQUIRED_AUTH_ENV_VARS = ['AZURE_AD_B2C_TENANT_NAME', 'AZURE_TENANT_ID', 'AZURE_CLIENT_ID'] as const;
const SENSITIVE_ENV_VARS = [
  'DB_PASSWORD',
  'ACS_CONNECTION_STRING',
  'AZURE_OPENAI_API_KEY',
  'OPENAI_API_KEY',
  'TWILIO_AUTH_TOKEN',
  'TELNYX_API_KEY',
] as const;
const KEY_VAULT_CHECK_CACHE_MS = 5 * 60 * 1000;

interface KeyVaultReferenceCheckResult {
  configured: boolean;
  missing: string[];
  source: 'arm' | 'runtime';
  error?: string;
}

let keyVaultReferenceCache: { expiresAt: number; result: KeyVaultReferenceCheckResult } | null = null;
const DEFAULT_APP_VERSION = '2.1.0';

function resolveAppVersion(): string {
  const fromEnv = process.env['APP_VERSION']?.trim() || process.env['npm_package_version']?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  try {
    const packageJsonPath = path.resolve(__dirname, '../../package.json');
    const packageJsonText = fs.readFileSync(packageJsonPath, 'utf-8');
    const parsed = JSON.parse(packageJsonText) as { version?: string };
    const fromPackage = parsed.version?.trim();
    if (fromPackage) {
      return fromPackage;
    }
  } catch {
    // Fall through to default when package metadata is unavailable.
  }

  return DEFAULT_APP_VERSION;
}

const APP_VERSION = resolveAppVersion();

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

function isKeyVaultReference(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  return value.trim().startsWith('@Microsoft.KeyVault(');
}

function nonKeyVaultSensitiveVars(): string[] {
  return SENSITIVE_ENV_VARS.filter((name) => {
    const value = process.env[name];
    if (!value) {
      return false;
    }
    return !isKeyVaultReference(value);
  });
}

function runtimeKeyVaultCheck(error?: string): KeyVaultReferenceCheckResult {
  const missing = nonKeyVaultSensitiveVars();
  return {
    configured: missing.length === 0,
    missing,
    source: 'runtime',
    ...(error ? { error } : {}),
  };
}

function resolveAzureSiteMetadata(): { subscriptionId: string; resourceGroup: string; siteName: string } | null {
  const subscriptionId = process.env['AZURE_SUBSCRIPTION_ID']?.trim();
  const resourceGroup = process.env['AZURE_RESOURCE_GROUP']?.trim();
  const siteName = (process.env['AZURE_WEBAPP_NAME'] ?? process.env['WEBSITE_SITE_NAME'])?.trim();

  if (!subscriptionId || !resourceGroup || !siteName) {
    return null;
  }

  return { subscriptionId, resourceGroup, siteName };
}

async function loadKeyVaultReferenceCheck(): Promise<KeyVaultReferenceCheckResult> {
  const cached = keyVaultReferenceCache;
  if (cached && cached.expiresAt > Date.now()) {
    return cached.result;
  }

  const metadata = resolveAzureSiteMetadata();
  if (!metadata) {
    const result = runtimeKeyVaultCheck('AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, or AZURE_WEBAPP_NAME is missing.');
    keyVaultReferenceCache = { expiresAt: Date.now() + KEY_VAULT_CHECK_CACHE_MS, result };
    return result;
  }

  try {
    const credential = new ManagedIdentityCredential();
    const token = await credential.getToken('https://management.azure.com/.default');
    if (!token?.token) {
      throw new Error('Managed identity token acquisition failed.');
    }

    const response = await fetch(
      `https://management.azure.com/subscriptions/${metadata.subscriptionId}/resourceGroups/${metadata.resourceGroup}/providers/Microsoft.Web/sites/${metadata.siteName}/config/appsettings/list?api-version=2023-12-01`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(`ARM appsettings query failed (${response.status}): ${responseText}`);
    }

    const payload = await response.json() as { properties?: Record<string, string | undefined> };
    const properties = payload.properties ?? {};
    const missing = SENSITIVE_ENV_VARS.filter((name) => {
      const value = properties[name];
      if (!value) {
        return false;
      }
      return !isKeyVaultReference(value);
    });

    const result: KeyVaultReferenceCheckResult = {
      configured: missing.length === 0,
      missing,
      source: 'arm',
    };
    keyVaultReferenceCache = { expiresAt: Date.now() + KEY_VAULT_CHECK_CACHE_MS, result };
    return result;
  } catch (error) {
    const result = runtimeKeyVaultCheck(error instanceof Error ? error.message : 'Unknown Key Vault check error.');
    keyVaultReferenceCache = { expiresAt: Date.now() + KEY_VAULT_CHECK_CACHE_MS, result };
    return result;
  }
}

// Liveness — always 200 if the process is running
router.get('/', apiLimiter, (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: APP_VERSION,
  });
});

// Readiness — 200 only when DB is reachable
router.get('/ready', apiLimiter, async (_req: Request, res: Response): Promise<void> => {
  try {
    const pool = await getPool();
    await pool.request().query('SELECT 1 AS ping');
    res.json({ status: 'ready', db: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    res.status(503).json({ status: 'unavailable', db: 'error', error: message, timestamp: new Date().toISOString() });
  }
});

router.get('/redis', apiLimiter, async (_req: Request, res: Response): Promise<void> => {
  const status = getShortLivedCacheRuntimeStatus();
  const probe = await runShortLivedCacheProbe();

  const payload = {
    status: probe.ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    cache: status,
    probe,
  };

  if (status.required && !probe.ok) {
    res.status(503).json(payload);
    return;
  }

  res.json(payload);
});

// Startup diagnostics — reports configuration health without exposing secrets
router.get('/startup', apiLimiter, async (_req: Request, res: Response) => {
  const authConfig = loadAuthConfig();
  const acsConfig = loadAcsConfig();
  const telnyxSmsConfig = loadTelnyxSmsConfig();
  const twilioSmsConfig = loadTwilioSmsConfig();
  const aiInviteRuntimeStatus = getAiInviteRuntimeStatus();
  const notificationStatus = getNotificationRuntimeStatus();
  const cacheStatus = getShortLivedCacheRuntimeStatus();
  const telemetryConfigured = Boolean(
    process.env['APPINSIGHTS_INSTRUMENTATIONKEY'] || process.env['APPLICATIONINSIGHTS_CONNECTION_STRING']
  );
  const dbMissing = missingEnvVars(REQUIRED_DB_ENV_VARS);
  const authMissing = missingAuthVars();
  const requireKeyVaultReferences = (process.env['REQUIRE_KEYVAULT_REFERENCES'] ?? 'false').toLowerCase() === 'true';
  const isProd = process.env['NODE_ENV'] === 'production';
  const strictNotificationFailure = notificationStatus.strictModeEnabled && notificationStatus.mode !== 'real';
  const cacheFailure = cacheStatus.required && (!cacheStatus.redisUrlDefined || !cacheStatus.redisConnected);
  const keyVaultCheck = await loadKeyVaultReferenceCheck();
  const keyVaultReferencesConfigured = keyVaultCheck.configured;
  const keyVaultPolicyFailure = requireKeyVaultReferences && !keyVaultReferencesConfigured;

  const summary = {
    status: dbMissing.length === 0 && !strictNotificationFailure && !cacheFailure && !keyVaultPolicyFailure ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    runtime: {
      nodeEnv: process.env['NODE_ENV'] ?? 'development',
      nodeVersion: process.version,
      portMode: Number.isNaN(Number.parseInt(process.env['PORT'] ?? '', 10)) ? 'pipe-or-string' : 'numeric',
    },
    checks: {
      dbEnvConfigured: dbMissing.length === 0,
      authConfigured: authConfig.isConfigured,
      notificationsConfigured: notificationStatus.mode !== 'stub',
      notificationMode: notificationStatus.mode,
      notificationStrictModeEnabled: notificationStatus.strictModeEnabled,
      emailNotificationChannel: notificationStatus.emailServiceMode,
      smsNotificationChannel: notificationStatus.smsServiceMode,
      aiInvitePreferredProvider: aiInviteRuntimeStatus.preferredProvider,
      aiInviteAnyProviderConfigured: aiInviteRuntimeStatus.hasAnyProviderConfigured,
      aiInviteAzureConfigured: aiInviteRuntimeStatus.azureConfigured,
      aiInviteOpenAiConfigured: aiInviteRuntimeStatus.openAiConfigured,
      aiInviteAzureEndpointHost: aiInviteRuntimeStatus.azureEndpointHost,
      aiInviteAzureDeployment: aiInviteRuntimeStatus.azureDeployment,
      aiInviteAzureApiVersion: aiInviteRuntimeStatus.azureApiVersion,
      aiInviteOpenAiModel: aiInviteRuntimeStatus.openAiModel,
      aiInviteTimeoutMs: aiInviteRuntimeStatus.timeoutMs,
      aiInviteIssues: aiInviteRuntimeStatus.issues,
      cacheProvider: cacheStatus.provider,
      cacheRedisConfigured: cacheStatus.redisConfigured,
      cacheRedisConnected: cacheStatus.redisConnected,
      cacheRedisRequired: cacheStatus.required,
      cacheRedisKeyPrefix: cacheStatus.redisKeyPrefix,
      cacheRedisError: cacheStatus.lastRedisError,
      telemetryConfigured,
      keyVaultReferencesConfigured,
      requireKeyVaultReferences,
      keyVaultReferenceCheckSource: keyVaultCheck.source,
      keyVaultReferenceCheckError: keyVaultCheck.error ?? null,
    },
    missing: {
      db: dbMissing,
      auth: authMissing,
      optional: [
        ...(!process.env['ACS_CONNECTION_STRING'] ? ['ACS_CONNECTION_STRING'] : []),
        ...(process.env['ACS_CONNECTION_STRING'] && !process.env['ACS_EMAIL_FROM'] ? ['ACS_EMAIL_FROM'] : []),
        ...(!telnyxSmsConfig.isConfigured && !twilioSmsConfig.isConfigured
          ? ['TELNYX_API_KEY/TELNYX_MESSAGING_PROFILE_ID_OR_TELNYX_FROM_NUMBER (or TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_MESSAGING_SERVICE_SID)']
          : []),
        ...(!telemetryConfigured ? ['APPINSIGHTS_INSTRUMENTATIONKEY_OR_APPLICATIONINSIGHTS_CONNECTION_STRING'] : []),
        ...(!aiInviteRuntimeStatus.hasAnyProviderConfigured ? ['AZURE_OPENAI_ENDPOINT/AZURE_OPENAI_API_KEY/AZURE_OPENAI_DEPLOYMENT or OPENAI_API_KEY'] : []),
      ],
      notifications: notificationStatus.reasons,
      cache: cacheFailure
        ? [cacheStatus.lastRedisError ?? 'Redis is required but not connected.']
        : [],
      keyVault: keyVaultCheck.missing,
    },
  };

  if (isProd && (dbMissing.length > 0 || strictNotificationFailure || cacheFailure || keyVaultPolicyFailure)) {
    res.status(503).json(summary);
    return;
  }

  res.json(summary);
});

export default router;
