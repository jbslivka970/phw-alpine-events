import { getPool, sql } from '../db';

/**
 * Idempotently ensures every email in AUTH_BOOTSTRAP_ADMIN_EMAILS exists in
 * the [user] table with role='admin' and is_active=1.  Behaviour:
 *   - Missing row  → INSERT with role='admin', is_active=1
 *   - Inactive row → reactivate (is_active=1) AND promote role to 'admin' if
 *                    the current role is below admin
 *   - Active row with role NOT in ('admin','superadmin') → promote to 'admin'
 *   - Active row already 'admin' or 'superadmin' → left untouched (never
 *     downgraded; superadmin retains its higher role)
 *
 * This guarantees the application always has at least one administrator
 * capable of signing in, even after AUTH_ALLOW_TOKEN_ROLE_FALLBACK was set
 * to false (which stops trusting Entra App-Role token claims).
 *
 * Safe to call repeatedly on every process start.
 */
export async function ensureBootstrapAdmins(): Promise<{ ensured: string[]; skipped: string[] }> {
  const raw = process.env['AUTH_BOOTSTRAP_ADMIN_EMAILS'] ?? '';
  const emails = raw
    .split(/[,;\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0 && value.includes('@'));

  if (emails.length === 0) {
    return { ensured: [], skipped: [] };
  }

  const ensured: string[] = [];
  const skipped: string[] = [];

  let pool;
  try {
    pool = await getPool();
  } catch (error) {
    console.warn('[bootstrap] cannot reach database — skipping admin bootstrap', error);
    return { ensured: [], skipped: emails };
  }

  for (const email of emails) {
    try {
      // MERGE-style: insert if missing; otherwise reactivate when inactive
      // and promote to 'admin' when the existing role is below admin.  We
      // never downgrade — rows already 'admin' or 'superadmin' are left
      // untouched (UPDATE clause WHERE-guard keeps action='NONE' in that
      // case).
      const result = await pool
        .request()
        .input('email', sql.NVarChar(255), email)
        .query<{ action: string }>(
          `MERGE dbo.[user] AS target
           USING (SELECT @email AS email) AS src
              ON LOWER(target.email) = src.email
           WHEN MATCHED AND (
                  target.is_active = 0
               OR target.role IS NULL
               OR LOWER(target.role) NOT IN ('admin', 'superadmin')
                ) THEN
                UPDATE SET
                  is_active  = 1,
                  role       = CASE
                                 WHEN LOWER(ISNULL(target.role, '')) = 'superadmin'
                                   THEN target.role
                                 ELSE 'admin'
                               END,
                  updated_at = GETUTCDATE()
           WHEN NOT MATCHED THEN
                INSERT (azure_oid, email, display_name, role, is_active)
                VALUES (NULL, src.email, src.email, 'admin', 1)
           OUTPUT $action AS action;`
        );
      const action = result.recordset[0]?.action ?? 'NONE';
      if (action === 'INSERT' || action === 'UPDATE') {
        ensured.push(email);
        console.log(JSON.stringify({
          level: 'info',
          event: 'bootstrap_admin_ensured',
          email,
          action,
          timestamp: new Date().toISOString(),
        }));
      } else {
        skipped.push(email);
      }
    } catch (error) {
      skipped.push(email);
      console.warn(`[bootstrap] failed to ensure admin ${email}`, error);
    }
  }

  return { ensured, skipped };
}

/**
 * Backfills [user].azure_oid for a row matched by email.  Called from the auth
 * middleware the first time a bootstrap admin signs in via CIAM so subsequent
 * lookups can resolve by OID (immune to email casing/whitespace drift).
 *
 * Returns true if a row was updated.
 */
export async function backfillAzureOidByEmail(email: string, oid: string): Promise<boolean> {
  if (!email || !oid) return false;
  const normalizedEmail = email.trim().toLowerCase();
  const trimmedOid = oid.trim();
  if (!normalizedEmail || !trimmedOid) return false;

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('email', sql.NVarChar(255), normalizedEmail)
      .input('oid', sql.NVarChar(255), trimmedOid)
      .query<{ updated: number }>(
        `UPDATE dbo.[user]
            SET azure_oid = @oid, updated_at = GETUTCDATE()
          WHERE LOWER(email) = @email
            AND (azure_oid IS NULL OR azure_oid = '');
         SELECT @@ROWCOUNT AS updated;`
      );
    const updated = (result.recordset[0]?.updated ?? 0) > 0;
    if (updated) {
      console.log(JSON.stringify({
        level: 'info',
        event: 'bootstrap_admin_oid_backfilled',
        email: normalizedEmail,
        timestamp: new Date().toISOString(),
      }));
    }
    return updated;
  } catch (error) {
    console.warn('[bootstrap] azure_oid backfill failed', error);
    return false;
  }
}
