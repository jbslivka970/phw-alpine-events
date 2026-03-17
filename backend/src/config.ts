import dotenv from 'dotenv';

dotenv.config();

interface ServerConfig {
  port: number | string;
  nodeEnv: string;
  corsOrigin?: string;
}

interface AuthConfig {
  tenantName: string;
  tenantId: string;
  clientId: string;
  policyName: string;
  isConfigured: boolean;
  issuer: string;
  jwksUri: string;
}

interface DbConfig {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

interface AcsConfig {
  isConfigured: boolean;
  connectionString?: string;
  emailFrom?: string;
  smsFrom?: string;
}

/**
 * Reads a required environment variable.  Throws in non-test environments if
 * the variable is missing so misconfigured deployments fail at startup instead
 * of generating confusing runtime errors.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    const isTest = process.env['NODE_ENV'] === 'test';
    if (!isTest) {
      throw new Error(`[config] Required environment variable "${name}" is not set. Refusing to start.`);
    }
    return '';
  }
  return value;
}

/**
 * Optional env var with a fallback.
 */
function optionalEnv(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

function loadServerConfig(): ServerConfig {
  const corsOrigin = optionalEnv('CORS_ORIGIN');
  const rawPort = optionalEnv('PORT', '3001') ?? '3001';
  const parsedPort = Number.parseInt(rawPort, 10);

  return {
    port: Number.isNaN(parsedPort) ? rawPort : parsedPort,
    nodeEnv: optionalEnv('NODE_ENV', 'development') ?? 'development',
    ...(corsOrigin ? { corsOrigin } : {}),
  };
}

function loadDbConfig(): DbConfig {
  const nodeEnv = optionalEnv('NODE_ENV', 'development') ?? 'development';
  const isProd = nodeEnv === 'production';

  return {
    server: isProd ? requireEnv('DB_HOST') : (optionalEnv('DB_HOST') ?? ''),
    port: parseInt(optionalEnv('DB_PORT', '1433') ?? '1433', 10),
    database: isProd ? requireEnv('DB_NAME') : (optionalEnv('DB_NAME') ?? ''),
    user: isProd ? requireEnv('DB_USER') : (optionalEnv('DB_USER') ?? ''),
    password: isProd ? requireEnv('DB_PASSWORD') : (optionalEnv('DB_PASSWORD') ?? ''),
  };
}

function loadAuthConfig(): AuthConfig {
  const tenantName = optionalEnv('AZURE_AD_B2C_TENANT_NAME') ?? '';
  const tenantId = optionalEnv('AZURE_TENANT_ID') ?? '';
  const clientId = optionalEnv('AZURE_CLIENT_ID') ?? '';
  const policyName = optionalEnv('AZURE_AD_B2C_POLICY_NAME', 'B2C_1_signupsignin') ?? 'B2C_1_signupsignin';
  const isConfigured = Boolean(tenantName && tenantId && clientId);

  return {
    tenantName,
    tenantId,
    clientId,
    policyName,
    isConfigured,
    issuer: `https://${tenantName}.b2clogin.com/${tenantId}/v2.0/`,
    jwksUri: `https://${tenantName}.b2clogin.com/${tenantId}/discovery/v2.0/keys?p=${policyName}`,
  };
}

function loadAcsConfig(): AcsConfig {
  const connectionString = optionalEnv('ACS_CONNECTION_STRING');
  const emailFrom = optionalEnv('ACS_EMAIL_FROM');
  const smsFrom = optionalEnv('ACS_SMS_FROM');

  if (!connectionString) {
    return {
      isConfigured: false,
      smsFrom,
    };
  }

  if (!emailFrom) {
    return {
      isConfigured: false,
      connectionString,
      smsFrom,
    };
  }

  return {
    isConfigured: true,
    connectionString,
    emailFrom,
    smsFrom,
  };
}

export { loadAcsConfig, loadAuthConfig, loadDbConfig, loadServerConfig };
export type { AcsConfig, AuthConfig, DbConfig, ServerConfig };
