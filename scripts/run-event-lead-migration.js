// One-shot runner for scripts/migrate-event-lead-member.sql.
// Usage:
//   MIGRATION_DB_PASSWORD=... node scripts/run-event-lead-migration.js
// Falls back to resolving DB_PASSWORD from backend/.env (Key Vault reference supported).

const sql = require(require('path').join(__dirname, '..', 'backend', 'node_modules', 'mssql'));
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const envFile = fs.readFileSync(path.join(__dirname, '..', 'backend', '.env'), 'utf8');
const env = {};
for (const line of envFile.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx === -1) continue;
  env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
}

let dbPassword = process.env.MIGRATION_DB_PASSWORD || env.DB_PASSWORD;
const kvMatch = dbPassword && dbPassword.match(/SecretUri=(https:\/\/[^/]+\.vault\.azure\.net\/secrets\/([^/]+))/);
if (kvMatch) {
  const secretName = kvMatch[2];
  const vaultName = kvMatch[1].replace('https://', '').split('.')[0];
  console.log('Resolving Key Vault password from', vaultName, '/', secretName);
  dbPassword = execSync(
    'az keyvault secret show --vault-name ' + vaultName + ' --name ' + secretName + ' --query value -o tsv',
    { encoding: 'utf8' }
  ).trim();
}

const config = {
  server: env.DB_HOST,
  port: parseInt(env.DB_PORT || '1433', 10),
  database: env.DB_NAME,
  user: env.DB_USER,
  password: dbPassword,
  options: { encrypt: true, trustServerCertificate: false },
  connectionTimeout: 30000,
  requestTimeout: 60000,
};

const migrationSql = fs.readFileSync(
  path.join(__dirname, 'migrate-event-lead-member.sql'),
  'utf8'
);

(async () => {
  console.log('Connecting to:', env.DB_HOST, '/', env.DB_NAME);
  try {
    await sql.connect(config);
    console.log('Connected. Running event_lead_member_id migration...');
    const result = await sql.query(migrationSql);
    console.log('Migration complete. Post-run state:');
    if (result && result.recordsets) {
      result.recordsets.forEach((rs, i) => {
        console.log('Resultset ' + (i + 1) + ':', JSON.stringify(rs, null, 2));
      });
    }
  } catch (err) {
    console.error('MIGRATION FAILED:', err.message);
    process.exit(1);
  } finally {
    await sql.close();
  }
})();
