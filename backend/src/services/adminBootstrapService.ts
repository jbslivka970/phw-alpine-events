import { getPool, sql } from '../db';

type BootstrapMode = 'admin' | 'root';

/**
 * Idempotently ensures configured bootstrap emails exist in dbo.[user].
 *
 * Supported env vars:
 *   - AUTH_BOOTSTRAP_ADMIN_EMAILS: tenant-level admin bootstrap rows
 *   - AUTH_BOOTSTRAP_ROOT_ADMIN_EMAILS: root-admin bootstrap rows
 *
 * Behaviour:
 *   - Missing admin row  → INSERT role='admin', is_active=1
 *   - Missing root row   → INSERT role='superadmin', is_root=1, root_role='root_admin'
 *   - Existing admin row → reactivate and promote to admin if below admin
 *   - Existing root row  → reactivate and promote to superadmin + root_admin
 *
 * We never downgrade an existing superadmin/root row when it also appears in
 * the legacy admin-only list.
 *
 * This guarantees the application always has at least one administrator
 * capable of signing in, even after AUTH_ALLOW_TOKEN_ROLE_FALLBACK was set
 * to false (which stops trusting Entra App-Role token claims).
 *
 * Safe to call repeatedly on every process start.
 */
export async function ensureBootstrapAdmins(): Promise<{ ensured: string[]; skipped: string[] }> {
  const parseEmails = (raw: string | undefined): string[] => (raw ?? '')
    .split(/[,;\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0 && value.includes('@'));

  const bootstrapModes = new Map<string, BootstrapMode>();

  for (const email of parseEmails(process.env['AUTH_BOOTSTRAP_ADMIN_EMAILS'])) {
    bootstrapModes.set(email, 'admin');
  }

  for (const email of parseEmails(process.env['AUTH_BOOTSTRAP_ROOT_ADMIN_EMAILS'])) {
    bootstrapModes.set(email, 'root');
  }

  const emails = [...bootstrapModes.keys()];

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
    const mode = bootstrapModes.get(email) ?? 'admin';
    try {
      const result = await pool
        .request()
        .input('email', sql.NVarChar(255), email)
        .input('bootstrap_mode', sql.NVarChar(20), mode)
        .query<{ action: string }>(
          `MERGE dbo.[user] AS target
           USING (SELECT @email AS email, @bootstrap_mode AS bootstrap_mode) AS src
              ON LOWER(target.email) = src.email
           WHEN MATCHED AND (
                  target.is_active = 0
               OR target.role IS NULL
               OR (src.bootstrap_mode = 'admin' AND LOWER(target.role) NOT IN ('admin', 'superadmin'))
               OR (src.bootstrap_mode = 'root' AND (
                    LOWER(target.role) <> 'superadmin'
                 OR ISNULL(target.is_root, 0) = 0
                 OR LOWER(ISNULL(target.root_role, '')) <> 'root_admin'
               ))
                ) THEN
                UPDATE SET
                  is_active  = 1,
                  role       = CASE
                                 WHEN src.bootstrap_mode = 'root' THEN 'superadmin'
                                 WHEN LOWER(ISNULL(target.role, '')) = 'superadmin' THEN target.role
                                 ELSE 'admin'
                               END,
                  is_root    = CASE
                                 WHEN src.bootstrap_mode = 'root' THEN 1
                                 ELSE ISNULL(target.is_root, 0)
                               END,
                  root_role  = CASE
                                 WHEN src.bootstrap_mode = 'root' THEN 'root_admin'
                                 ELSE target.root_role
                               END,
                  updated_at = GETUTCDATE()
           WHEN NOT MATCHED THEN
                INSERT (azure_oid, email, display_name, role, is_active, is_root, root_role)
                VALUES (
                  NULL,
                  src.email,
                  src.email,
                  CASE WHEN src.bootstrap_mode = 'root' THEN 'superadmin' ELSE 'admin' END,
                  1,
                  CASE WHEN src.bootstrap_mode = 'root' THEN 1 ELSE 0 END,
                  CASE WHEN src.bootstrap_mode = 'root' THEN 'root_admin' ELSE NULL END
                )
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
