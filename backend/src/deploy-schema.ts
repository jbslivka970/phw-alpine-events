import sql from 'mssql';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

function requireEnv(primaryName: string, fallbackName?: string): string {
  const primaryValue = process.env[primaryName]?.trim();
  if (primaryValue) {
    return primaryValue;
  }

  const fallbackValue = fallbackName ? process.env[fallbackName]?.trim() : undefined;
  if (fallbackValue) {
    return fallbackValue;
  }

  throw new Error(
    fallbackName
      ? `Missing required environment variable: ${primaryName} (or fallback ${fallbackName})`
      : `Missing required environment variable: ${primaryName}`,
  );
}

const schemaPath = path.resolve(
  __dirname,
  process.env['SCHEMA_SQL_PATH']?.trim() || '../../database/schema.sql',
);

const config: sql.config = {
  server: requireEnv('MIGRATION_DB_HOST', 'DB_HOST'),
  port: Number.parseInt(process.env['MIGRATION_DB_PORT'] || process.env['DB_PORT'] || '1433', 10),
  database: requireEnv('MIGRATION_DB_NAME', 'DB_NAME'),
  user: requireEnv('MIGRATION_DB_USER', 'DB_USER'),
  password: requireEnv('MIGRATION_DB_PASSWORD', 'DB_PASSWORD'),
  options: {
    encrypt: true,
    trustServerCertificate: false,
  },
  connectionTimeout: 30000,
  requestTimeout: 120000,
};

async function deploySchema() {
  let pool: sql.ConnectionPool | undefined;
  try {
    console.log(`Connecting to Azure SQL Database ${config.database} at ${config.server}:${config.port}...`);
    pool = await new sql.ConnectionPool(config).connect();
    console.log('Connected successfully.');

    const schema = fs.readFileSync(schemaPath, 'utf8');

    console.log(`Executing schema deployment from ${schemaPath}...`);
    await pool.request().query(schema);
    console.log('Schema deployed successfully.');

  } catch (err) {
    console.error('Error deploying schema:', err);
    throw err;
  } finally {
    if (pool) {
      await pool.close();
    }
  }
}

void deploySchema().catch(() => {
  process.exit(1);
});