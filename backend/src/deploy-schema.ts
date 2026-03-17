import sql from 'mssql';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const REQUIRED_ENV_VARS = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];

function validateEnv(): void {
  const missing = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`[deploy-schema] Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function buildConfig(): sql.config {
  return {
    server: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT || '1433', 10),
    database: process.env.DB_NAME!,
    user: process.env.DB_USER!,
    password: process.env.DB_PASSWORD!,
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
    connectionTimeout: 30000,
    requestTimeout: 60000,
  };
}

async function deploySchema(): Promise<void> {
  validateEnv();

  const pool = new sql.ConnectionPool(buildConfig());

  try {
    console.log('[deploy-schema] Connecting to Azure SQL Database...');
    await pool.connect();
    console.log('[deploy-schema] Connected successfully.');

    const schemaPath = path.join(__dirname, '../../database/schema.sql');
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`Schema file not found at: ${schemaPath}`);
    }

    const schema = fs.readFileSync(schemaPath, 'utf8');

    // Split on GO statements (T-SQL batch separator) so each batch runs independently
    const batches = schema
      .split(/^\s*GO\s*$/im)
      .map((b) => b.trim())
      .filter((b) => b.length > 0);

    console.log(`[deploy-schema] Executing ${batches.length} SQL batch(es)...`);

    for (let i = 0; i < batches.length; i++) {
      const request = pool.request();
      await request.query(batches[i]);
      console.log(`[deploy-schema] Batch ${i + 1}/${batches.length} completed.`);
    }

    console.log('[deploy-schema] Schema deployed successfully (idempotent).');
  } catch (err) {
    console.error('[deploy-schema] Error deploying schema:', err);
    process.exit(1);
  } finally {
    await pool.close();
    console.log('[deploy-schema] Connection closed.');
  }
}

deploySchema();