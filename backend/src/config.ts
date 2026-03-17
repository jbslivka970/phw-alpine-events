import dotenv from 'dotenv';

dotenv.config();

interface Config {
  port: number;
  nodeEnv: string;
  db: {
    host: string;
    port: number;
    name: string;
    user: string;
    password: string;
  };
  azure: {
    clientId: string;
    tenantId: string;
    clientSecret: string;
  };
  acs: {
    connectionString: string;
    emailFrom: string;
    smsFrom: string;
  };
}

function loadConfig(): Config {
  const missingVars: string[] = [];

  function getRequired(key: string): string {
    const value = process.env[key];
    if (!value) missingVars.push(key);
    return value ?? '';
  }

  const config: Config = {
    port: parseInt(process.env['PORT'] ?? '3001', 10),
    nodeEnv: process.env['NODE_ENV'] ?? 'development',
    db: {
      host: getRequired('DB_HOST'),
      port: parseInt(process.env['DB_PORT'] ?? '1433', 10),
      name: getRequired('DB_NAME'),
      user: getRequired('DB_USER'),
      password: getRequired('DB_PASSWORD'),
    },
    azure: {
      clientId: getRequired('AZURE_CLIENT_ID'),
      tenantId: getRequired('AZURE_TENANT_ID'),
      clientSecret: getRequired('AZURE_CLIENT_SECRET'),
    },
    acs: {
      connectionString: getRequired('ACS_CONNECTION_STRING'),
      emailFrom: getRequired('ACS_EMAIL_FROM'),
      smsFrom: getRequired('ACS_SMS_FROM'),
    },
  };

  if (missingVars.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missingVars.join(', ')}`
    );
  }

  return config;
}

export { loadConfig };
export type { Config };
