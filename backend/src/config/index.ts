import dotenv from 'dotenv';
dotenv.config();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
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
