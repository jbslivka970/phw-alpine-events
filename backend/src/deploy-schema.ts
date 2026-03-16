import sql from 'mssql';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';

dotenv.config();

const config: sql.config = {
  server: process.env.DB_HOST!,
  port: parseInt(process.env.DB_PORT || '1433'),
  database: process.env.DB_NAME!,
  user: process.env.DB_USER!,
  password: process.env.DB_PASSWORD!,
  options: {
    encrypt: true,
    trustServerCertificate: false,
  },
};

async function deploySchema() {
  const pool = new sql.ConnectionPool(config);
  try {
    console.log('Connecting to Azure SQL Database...');
    await pool.connect();
    console.log('Connected successfully.');

    const schemaPath = path.join(__dirname, '../../database/schema.sql');
    const schema = fs.readFileSync(schemaPath, 'utf8');

    console.log('Executing schema deployment...');
    const request = pool.request();
    await request.query(schema);
    console.log('Schema deployed successfully.');

  } catch (err) {
    console.error('Error deploying schema:', err);
  } finally {
    await pool.close();
  }
}

deploySchema();