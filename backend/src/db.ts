import sql from 'mssql';

let pool: sql.ConnectionPool | null = null;

function getConnectionConfig(): sql.config {
  return {
    server: process.env['DB_HOST'] ?? '',
    port: parseInt(process.env['DB_PORT'] ?? '1433', 10),
    database: process.env['DB_NAME'] ?? '',
    user: process.env['DB_USER'] ?? '',
    password: process.env['DB_PASSWORD'] ?? '',
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