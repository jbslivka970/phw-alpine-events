import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  db: {
    server: process.env.DB_HOST || '',
    port: parseInt(process.env.DB_PORT || '1433', 10),
    database: process.env.DB_NAME || '',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
  },

  azure: {
    tenantId: process.env.AZURE_TENANT_ID || '',
    clientId: process.env.AZURE_CLIENT_ID || '',
    clientSecret: process.env.AZURE_CLIENT_SECRET || '',
    b2cTenantName: process.env.AZURE_AD_B2C_TENANT_NAME || '',
    b2cPolicyName: process.env.AZURE_AD_B2C_POLICY_NAME || '',
  },

  acs: {
    connectionString: process.env.ACS_CONNECTION_STRING || '',
    emailFrom: process.env.ACS_EMAIL_FROM || '',
    smsFrom: process.env.ACS_SMS_FROM || '',
  },
};
