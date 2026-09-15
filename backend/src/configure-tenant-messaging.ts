import sql from 'mssql';
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

  throw new Error(`Missing required environment variable: ${primaryName}${fallbackName ? ` (or ${fallbackName})` : ''}`);
}

const tenantSlug = requireEnv('TENANT_MESSAGING_TENANT_SLUG');
const telnyxFromNumber = requireEnv('TENANT_MESSAGING_TELNYX_FROM_NUMBER');
const telnyxMessagingProfileId = requireEnv('TENANT_MESSAGING_TELNYX_PROFILE_ID');

const config: sql.config = {
  server: requireEnv('MIGRATION_DB_HOST', 'DB_HOST'),
  port: Number.parseInt(process.env['MIGRATION_DB_PORT'] || process.env['DB_PORT'] || '1433', 10),
  database: requireEnv('MIGRATION_DB_NAME', 'DB_NAME'),
  user: requireEnv('MIGRATION_DB_USER', 'DB_USER'),
  password: requireEnv('MIGRATION_DB_PASSWORD', 'DB_PASSWORD'),
  options: { encrypt: true, trustServerCertificate: false },
  connectionTimeout: 30000,
  requestTimeout: 120000,
};

async function configureTenantMessaging() {
  const pool = await new sql.ConnectionPool(config).connect();
  try {
    const result = await pool.request()
      .input('tenant_slug', sql.NVarChar(100), tenantSlug)
      .input('from_number', sql.NVarChar(30), telnyxFromNumber)
      .input('profile_id', sql.NVarChar(64), telnyxMessagingProfileId)
      .query<{ tenant_id: string }>(`
        UPDATE tm
        SET sms_enabled = 1,
            sms_provider = 'telnyx',
            telnyx_from_number = @from_number,
            telnyx_messaging_profile_id = @profile_id,
            updated_at = GETUTCDATE()
        OUTPUT inserted.tenant_id
        FROM dbo.tenant_messaging tm
        INNER JOIN dbo.tenant t ON t.tenant_id = tm.tenant_id
        WHERE t.slug = @tenant_slug
          AND t.status = 'active';
      `);

    if (result.recordset.length !== 1) {
      throw new Error(`Expected exactly one active tenant messaging row for slug ${tenantSlug}; updated ${result.recordset.length}.`);
    }

    console.log(`Configured Telnyx messaging for active tenant slug ${tenantSlug}.`);
  } finally {
    await pool.close();
  }
}

void configureTenantMessaging().catch((error: unknown) => {
  console.error('Error configuring tenant messaging:', error);
  process.exit(1);
});
