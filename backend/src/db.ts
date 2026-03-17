import sql from 'mssql';
import { loadDbConfig } from './config';

let pool: sql.ConnectionPool | null = null;

function getConnectionConfig(): sql.config {
  const cfg = loadDbConfig();
  return {
    server: cfg.server,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
  };
}

async function getPool(): Promise<sql.ConnectionPool> {
  if (pool && pool.connected) {
    return pool;
  }

  pool = await new sql.ConnectionPool(getConnectionConfig()).connect();
  return pool;
}

async function closePool(): Promise<void> {
  if (pool) {
    await pool.close();
    pool = null;
  }
}

export { closePool, getPool, sql };