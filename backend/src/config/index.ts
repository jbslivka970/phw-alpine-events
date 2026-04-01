import dotenv from 'dotenv';
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    if (process.env.NODE_ENV === 'test') return '';
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback?: string): string | undefined {
  return process.env[name] || fallback;
}

export interface AcsConfig {
  isConfigured: boolean;
  connectionString: string;
  emailFrom: string;
  smsFrom?: string;
}

export function loadAcsConfig(): AcsConfig {
  const connectionString = process.env.ACS_CONNECTION_STRING || '';
  if (!connectionString) {
    return { isConfigured: false, connectionString: '', emailFrom: '' };
  }
  const emailFrom = process.env.ACS_EMAIL_FROM || '';
  const smsFrom = optionalEnv('ACS_SMS_FROM');
  return { isConfigured: true, connectionString, emailFrom, smsFrom };
}

export const config = {
  port: (() => {
    const rawPort = process.env.PORT || '3001';
    const parsedPort = Number.parseInt(rawPort, 10);
    return Number.isNaN(parsedPort) ? rawPort : parsedPort;
  })(),
  nodeEnv: process.env.NODE_ENV || 'development',

  db: {
    server: process.env.DB_HOST || '',
    port: parseInt(process.env.DB_PORT || '1433', 10),
    database: process.env.DB_NAME || '',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    options: {
      encrypt: true,
      trustServerCertificate: process.env.NODE_ENV !== 'production',
    },
  },

  azure: {
    tenantId: process.env.AZURE_TENANT_ID || '',
    clientId: process.env.AZURE_CLIENT_ID || '',
    b2cTenantName: process.env.AZURE_AD_B2C_TENANT_NAME || '',
    b2cPolicyName: process.env.AZURE_AD_B2C_POLICY_NAME || '',
  },

  acs: {
    connectionString: process.env.ACS_CONNECTION_STRING || '',
    emailFrom: process.env.ACS_EMAIL_FROM || '',
    smsFrom: process.env.ACS_SMS_FROM || '',
  },
};

export { requireEnv, optionalEnv };
