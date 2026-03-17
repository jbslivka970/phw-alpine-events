import dotenv from 'dotenv';

dotenv.config();

interface ServerConfig {
  port: number;
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

function loadServerConfig(): ServerConfig {
  const corsOrigin = process.env['CORS_ORIGIN'];

  return {
    port: parseInt(process.env['PORT'] ?? '3001', 10),
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    ...(corsOrigin ? { corsOrigin } : {}),
  };
}

function loadAuthConfig(): AuthConfig {
  const tenantName = process.env['AZURE_AD_B2C_TENANT_NAME'] ?? '';
  const tenantId = process.env['AZURE_TENANT_ID'] ?? '';
  const clientId = process.env['AZURE_CLIENT_ID'] ?? '';
  const policyName = process.env['AZURE_AD_B2C_POLICY_NAME'] ?? 'B2C_1_signupsignin';
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

export { loadAuthConfig, loadServerConfig };
export type { AuthConfig, ServerConfig };