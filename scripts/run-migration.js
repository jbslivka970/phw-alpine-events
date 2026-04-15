// Password can be passed via MIGRATION_DB_PASSWORD env var or resolved from Key Vault
// Run: az keyvault secret show --vault-name kv-phw-alpine-prod --name db-password --query value -o tsv > /tmp/phw_dbpass.tmp
//      MIGRATION_DB_PASSWORD=$(cat /tmp/phw_dbpass.tmp) node scripts/run-migration.js
// One-shot migration runner — uses backend/.env and mssql from backend/node_modules
// Usage: node scripts/run-migration.js
const sql = require(require('path').join(__dirname, '..', 'backend', 'node_modules', 'mssql'));
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Resolve password: if .env contains a @Microsoft.KeyVault(...) reference, pull from Key Vault
const envFile = fs.readFileSync(path.join(__dirname, '..', 'backend', '.env'), 'utf8');
const env = {};
for (const line of envFile.split('\n')) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx === -1) continue;
  env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
}

let dbPassword = env.DB_PASSWORD;
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
  path.join(__dirname, 'migrate-v2-p0-p2.sql'),
  'utf8'
);

(async () => {
(async () => {
  console.log('Connecting to:', env.DB_HOST, '/', env.DB_NAME);
  // Split at the phase marker so SQL Server compiles each batch independently.
  // Phase 1 adds columns; Phase 2 can then safely reference them.
  const splitIdx = migrationSql.indexOf('-- PHASE_1_END');
  const phase1Sql = migrationSql.slice(0, splitIdx);
  // Skip the rest of the PHASE_1_END line (the inline annotation) before phase 2 SQL
  const afterMarker = migrationSql.slice(splitIdx);
  const phase2Sql = afterMarker.slice(afterMarker.indexOf('\n') + 1);
  try {
    await sql.connect(config);
    console.log('Connected.');
    console.log('Running Phase 1 (column DDL)...');
    await sql.query(phase1Sql);
    console.log('Phase 1 complete.');
    console.log('Running Phase 2 (constraints, backfill, cleanup)...');
    const result = await sql.query(phase2Sql);
    console.log('Phase 2 complete. Post-run checks:');
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
