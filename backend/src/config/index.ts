import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Azure SQL Database
  db: {
    host: process.env.DB_HOST || '',
    port: parseInt(process.env.DB_PORT || '1433', 10),
    name: process.env.DB_NAME || '',
    user: process.env.DB_USER || '',
    password: process.env.DB_PASSWORD || '',
  },

  // Azure AD B2C
  azureAdB2c: {
    tenantName: process.env.AZURE_AD_B2C_TENANT_NAME || '',
    tenantId: process.env.AZURE_TENANT_ID || '',
    clientId: process.env.AZURE_CLIENT_ID || '',
    policyName: process.env.AZURE_AD_B2C_POLICY_NAME || 'B2C_1_signupsignin',
    // Derived JWKS URI: https://{tenantName}.b2clogin.com/{tenantId}/discovery/v2.0/keys?p={policyName}
    get jwksUri(): string {
      return `https://${this.tenantName}.b2clogin.com/${this.tenantId}/discovery/v2.0/keys?p=${this.policyName}`;
    },
    // Derived issuer: https://{tenantName}.b2clogin.com/{tenantId}/v2.0/
    get issuer(): string {
      return `https://${this.tenantName}.b2clogin.com/${this.tenantId}/v2.0/`;
    },
  },

  // CORS
  corsOrigin: process.env.CORS_ORIGIN || '*',
};

export default config;
