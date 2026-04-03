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
  emailTo?: string;
  smsFrom?: string;
}

interface TwilioSmsConfig {
  isConfigured: boolean;
  accountSid?: string;
  authToken?: string;
  messagingServiceSid?: string;
}

interface TelnyxSmsConfig {
  isConfigured: boolean;
  apiKey?: string;
  messagingProfileId?: string;
  fromNumber?: string;
}

interface RsvpLinkConfig {
  isConfigured: boolean;
  frontendBaseUrl: string;
  tokenSecret: string;
  tokenExpiryHours: number;
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
  const tenantName = optionalEnv('AZURE_EXTERNAL_TENANT_NAME') ?? optionalEnv('AZURE_AD_B2C_TENANT_NAME') ?? '';
  const tenantId = optionalEnv('AZURE_EXTERNAL_TENANT_ID') ?? optionalEnv('AZURE_TENANT_ID') ?? '';
  const clientId = optionalEnv('AZURE_CLIENT_ID') ?? '';
  const policyName = optionalEnv('AZURE_EXTERNAL_USER_FLOW')
    ?? optionalEnv('AZURE_AD_B2C_POLICY_NAME', 'B2C_1_signupsignin')
    ?? 'B2C_1_signupsignin';
  const authorityHost = optionalEnv('AZURE_AUTHORITY_HOST') ?? 'b2clogin.com';
  const issuerOverride = optionalEnv('AZURE_AUTH_ISSUER') ?? '';
  const jwksOverride = optionalEnv('AZURE_AUTH_JWKS_URI') ?? '';

  const issuer = issuerOverride || `https://${tenantName}.${authorityHost}/${tenantId}/v2.0/`;
  const jwksUri = jwksOverride || `https://${tenantName}.${authorityHost}/${tenantId}/discovery/v2.0/keys?p=${policyName}`;
  const isConfigured = Boolean(clientId && issuer && jwksUri);

  return {
    tenantName,
    tenantId,
    clientId,
    policyName,
    isConfigured,
    issuer,
    jwksUri,
  };
}

function loadAcsConfig(): AcsConfig {
  const connectionString = optionalEnv('ACS_CONNECTION_STRING');
  const emailFrom = optionalEnv('ACS_EMAIL_FROM');
  const emailTo = optionalEnv('ACS_EMAIL_TO');
  const smsFrom = optionalEnv('ACS_SMS_FROM');

  if (!connectionString) {
    return {
      isConfigured: false,
      smsFrom,
      emailTo,
    };
  }

  if (!emailFrom) {
    return {
      isConfigured: false,
      connectionString,
      smsFrom,
      emailTo,
    };
  }

  return {
    isConfigured: true,
    connectionString,
    emailFrom,
    emailTo,
    smsFrom,
  };
}

function loadRsvpLinkConfig(): RsvpLinkConfig {
  const nodeEnv = optionalEnv('NODE_ENV', 'development') ?? 'development';
  const frontendBaseUrl = (
    optionalEnv('FRONTEND_APP_URL')
    ?? optionalEnv('PUBLIC_APP_URL')
    ?? optionalEnv('CORS_ORIGIN')
    ?? (nodeEnv === 'production' ? '' : 'http://localhost:5173')
  ).replace(/\/$/, '');
  const tokenSecret = optionalEnv('RSVP_TOKEN_SECRET', nodeEnv === 'production' ? undefined : 'dev-rsvp-secret') ?? '';
  const rawExpiry = optionalEnv('RSVP_TOKEN_EXPIRY_HOURS', '168') ?? '168';
  const parsedExpiry = Number.parseInt(rawExpiry, 10);

  return {
    isConfigured: Boolean(frontendBaseUrl && tokenSecret),
    frontendBaseUrl,
    tokenSecret,
    tokenExpiryHours: Number.isNaN(parsedExpiry) ? 168 : parsedExpiry,
  };
}

function loadTwilioSmsConfig(): TwilioSmsConfig {
  const accountSid = optionalEnv('TWILIO_ACCOUNT_SID');
  const authToken = optionalEnv('TWILIO_AUTH_TOKEN');
  const messagingServiceSid = optionalEnv('TWILIO_MESSAGING_SERVICE_SID');

  const isConfigured = Boolean(accountSid && authToken && messagingServiceSid);
  return {
    isConfigured,
    accountSid,
    authToken,
    messagingServiceSid,
  };
}

function loadTelnyxSmsConfig(): TelnyxSmsConfig {
  const apiKey = optionalEnv('TELNYX_API_KEY');
  const messagingProfileId = optionalEnv('TELNYX_MESSAGING_PROFILE_ID');
  const fromNumber = optionalEnv('TELNYX_FROM_NUMBER');

  const isConfigured = Boolean(apiKey && (messagingProfileId || fromNumber));
  return {
    isConfigured,
    apiKey,
    messagingProfileId,
    fromNumber,
  };
}

export { loadAcsConfig, loadAuthConfig, loadDbConfig, loadRsvpLinkConfig, loadServerConfig, loadTwilioSmsConfig, loadTelnyxSmsConfig };
export type { AcsConfig, AuthConfig, DbConfig, RsvpLinkConfig, ServerConfig, TwilioSmsConfig, TelnyxSmsConfig };
