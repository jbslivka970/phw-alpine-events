import { getPool, sql } from '../db';

type TenantType = 'program' | 'demo' | 'system';
type TenantStatus = 'active' | 'suspended' | 'archived';

interface CreateTenantInput {
  slug: string;
  displayName: string;
  tenantType?: TenantType;
  status?: TenantStatus;
  timezone?: string;
  isDemo?: boolean;
  isOperational?: boolean;
}

interface TenantSummary {
  tenant_id: string;
  slug: string;
  display_name: string;
  tenant_type: TenantType;
  status: TenantStatus;
  timezone: string;
  is_demo: boolean;
  is_operational: boolean;
  created_at: string;
}

interface TenantUsageSummary {
  tenant_id: string;
  members_total: number;
  events_total: number;
  event_responses_total: number;
  notifications_total: number;
  notification_failures_total: number;
  email_opt_out_total: number;
  sms_opt_out_total: number;
  calculated_at: string;
}

interface GrantTenantAdminInput {
  tenantId: string;
  email: string;
  displayName?: string | null;
  actorEmail?: string | null;
  expiresAt?: string | null;
}

interface TenantAdminSummary {
  tenant_membership_id: string;
  tenant_id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  role: string;
  membership_kind: string;
  status: string;
  starts_at: string;
  expires_at: string | null;
}

interface GrantDemoAccessInput {
  tenantId: string;
  email: string;
  displayName?: string | null;
  actorEmail?: string | null;
  expiresAt: string;
}

interface DemoAccessSummary {
  tenant_membership_id: string;
  tenant_id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  role: string;
  membership_kind: string;
  status: string;
  starts_at: string;
  expires_at: string | null;
}

interface TenantStatusRow {
  tenant_id: string;
  slug: string;
  display_name: string;
  tenant_type: TenantType;
  status: TenantStatus;
  timezone: string;
  is_demo: boolean | number;
  is_operational: boolean | number;
  created_at: Date | string;
}

function asBool(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

function asIso(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/--+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeDisplayName(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

async function createTenant(input: CreateTenantInput): Promise<TenantSummary> {
  const slug = normalizeSlug(input.slug);
  const displayName = input.displayName.trim();
  if (!slug) {
    throw new Error('slug is required');
  }
  if (!displayName) {
    throw new Error('displayName is required');
  }

  const tenantType: TenantType = input.tenantType ?? 'program';
  const status: TenantStatus = input.status ?? 'active';
  const timezone = (input.timezone?.trim() || 'America/Denver');
  const isDemo = input.isDemo ?? (tenantType === 'demo');
  const isOperational = input.isOperational ?? !isDemo;

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const insertTenant = await new sql.Request(transaction)
      .input('slug', sql.NVarChar(100), slug)
      .input('display_name', sql.NVarChar(200), displayName)
      .input('tenant_type', sql.NVarChar(20), tenantType)
      .input('status', sql.NVarChar(20), status)
      .input('timezone', sql.NVarChar(64), timezone)
      .input('is_demo', sql.Bit, isDemo ? 1 : 0)
      .input('is_operational', sql.Bit, isOperational ? 1 : 0)
      .query<{
        tenant_id: string;
        slug: string;
        display_name: string;
        tenant_type: TenantType;
        status: TenantStatus;
        timezone: string;
        is_demo: boolean | number;
        is_operational: boolean | number;
        created_at: Date | string;
      }>(
        `IF EXISTS (SELECT 1 FROM dbo.tenant WHERE slug = @slug)
           THROW 50001, 'Tenant slug already exists', 1;

         DECLARE @new_tenant_id UNIQUEIDENTIFIER = NEWID();

         INSERT INTO dbo.tenant (
           tenant_id,
           slug,
           display_name,
           tenant_type,
           status,
           timezone,
           is_demo,
           is_operational,
           created_at
         )
         VALUES (
           @new_tenant_id,
           @slug,
           @display_name,
           @tenant_type,
           @status,
           @timezone,
           @is_demo,
           @is_operational,
           GETUTCDATE()
         );

         INSERT INTO dbo.tenant_branding (
           tenant_id,
           org_long_name,
           org_short_name,
           created_at,
           updated_at
         )
         VALUES (
           @new_tenant_id,
           @display_name,
           @display_name,
           GETUTCDATE(),
           GETUTCDATE()
         );

         INSERT INTO dbo.tenant_messaging (
           tenant_id,
           created_at,
           updated_at
         )
         VALUES (
           @new_tenant_id,
           GETUTCDATE(),
           GETUTCDATE()
         );

         SELECT TOP (1)
           tenant_id,
           slug,
           display_name,
           tenant_type,
           status,
           timezone,
           is_demo,
           is_operational,
           created_at
         FROM dbo.tenant
         WHERE tenant_id = @new_tenant_id;`
      );

    const row = insertTenant.recordset[0];
    if (!row) {
      throw new Error('Failed to create tenant');
    }

    await transaction.commit();

    return {
      tenant_id: row.tenant_id,
      slug: row.slug,
      display_name: row.display_name,
      tenant_type: row.tenant_type,
      status: row.status,
      timezone: row.timezone,
      is_demo: asBool(row.is_demo),
      is_operational: asBool(row.is_operational),
      created_at: asIso(row.created_at) ?? new Date().toISOString(),
    };
  } catch (error) {
    await transaction.rollback();
    if (error instanceof Error && /Tenant slug already exists/i.test(error.message)) {
      throw new Error('Tenant slug already exists');
    }
    throw error;
  }
}

async function listTenantAdmins(tenantId: string): Promise<TenantAdminSummary[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .query<{
      tenant_membership_id: string;
      tenant_id: string;
      user_id: string;
      email: string;
      display_name: string | null;
      role: string;
      membership_kind: string;
      status: string;
      starts_at: Date | string;
      expires_at: Date | string | null;
    }>(
      `SELECT
          tm.tenant_membership_id,
          tm.tenant_id,
          tm.user_id,
          u.email,
          u.display_name,
          tm.role,
          tm.membership_kind,
          tm.status,
          tm.starts_at,
          tm.expires_at
       FROM dbo.tenant_membership tm
       INNER JOIN dbo.[user] u
         ON u.user_id = tm.user_id
       WHERE tm.tenant_id = @tenant_id
         AND tm.status = 'active'
         AND tm.revoked_at IS NULL
         AND tm.membership_kind = 'admin'
       ORDER BY u.email ASC`
    );

  return result.recordset.map((row) => ({
    tenant_membership_id: row.tenant_membership_id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    membership_kind: row.membership_kind,
    status: row.status,
    starts_at: asIso(row.starts_at) ?? new Date().toISOString(),
    expires_at: asIso(row.expires_at),
  }));
}

async function grantTenantAdminByEmail(input: GrantTenantAdminInput): Promise<TenantAdminSummary[]> {
  const tenantId = input.tenantId.trim();
  const normalizedEmail = normalizeEmail(input.email);
  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new Error('Valid email is required');
  }

  const displayName = normalizeDisplayName(input.displayName) ?? normalizedEmail;
  const actorEmail = normalizeDisplayName(input.actorEmail) ? normalizeEmail(input.actorEmail as string) : normalizedEmail;
  const expiresAt = input.expiresAt?.trim() ? new Date(input.expiresAt) : null;

  if (expiresAt && Number.isNaN(expiresAt.getTime())) {
    throw new Error('expiresAt must be a valid ISO timestamp');
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const tenantLookup = await new sql.Request(transaction)
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .query<{ tenant_id: string }>('SELECT tenant_id FROM dbo.tenant WHERE tenant_id = @tenant_id');
    if (!tenantLookup.recordset[0]) {
      throw new Error('Tenant not found');
    }

    const actorLookup = await new sql.Request(transaction)
      .input('actor_email', sql.NVarChar(255), actorEmail)
      .query<{ user_id: string }>('SELECT TOP (1) user_id FROM dbo.[user] WHERE LOWER(email) = @actor_email');
    const actorUserId = actorLookup.recordset[0]?.user_id ?? null;

    const ensureUser = await new sql.Request(transaction)
      .input('email', sql.NVarChar(255), normalizedEmail)
      .input('display_name', sql.NVarChar(200), displayName)
      .query<{ user_id: string }>(
        `MERGE dbo.[user] AS target
         USING (SELECT @email AS email) AS src
            ON LOWER(target.email) = src.email
         WHEN MATCHED THEN
            UPDATE SET
              display_name = COALESCE(@display_name, target.display_name),
              is_active = 1,
              updated_at = GETUTCDATE()
         WHEN NOT MATCHED THEN
            INSERT (user_id, azure_oid, email, display_name, role, is_active, is_root, root_role, created_at, updated_at)
            VALUES (NEWID(), NULL, @email, @display_name, 'admin', 1, 0, NULL, GETUTCDATE(), GETUTCDATE())
         OUTPUT INSERTED.user_id;`
      );

    const userId = ensureUser.recordset[0]?.user_id;
    if (!userId) {
      throw new Error('Failed to ensure user for tenant admin grant');
    }

    await new sql.Request(transaction)
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .input('user_id', sql.UniqueIdentifier, userId)
      .input('expires_at', sql.DateTime, expiresAt)
      .input('created_by_user_id', sql.UniqueIdentifier, actorUserId)
      .query(
        `IF EXISTS (
            SELECT 1
            FROM dbo.tenant_membership
            WHERE tenant_id = @tenant_id
              AND user_id = @user_id
              AND membership_kind = 'admin'
              AND status = 'active'
              AND revoked_at IS NULL
         )
           BEGIN
             UPDATE dbo.tenant_membership
             SET role = 'admin',
                 expires_at = @expires_at,
                 revoked_at = NULL
             WHERE tenant_id = @tenant_id
               AND user_id = @user_id
               AND membership_kind = 'admin'
               AND status = 'active'
               AND revoked_at IS NULL;
           END
         ELSE
           BEGIN
             INSERT INTO dbo.tenant_membership (
               tenant_membership_id,
               tenant_id,
               user_id,
               member_id,
               role,
               membership_kind,
               home_tenant_id,
               starts_at,
               expires_at,
               status,
               created_by_user_id,
               created_at,
               revoked_at
             )
             VALUES (
               NEWID(),
               @tenant_id,
               @user_id,
               NULL,
               'admin',
               'admin',
               NULL,
               GETUTCDATE(),
               @expires_at,
               'active',
               @created_by_user_id,
               GETUTCDATE(),
               NULL
             );
           END`
      );

    await transaction.commit();
    return listTenantAdmins(tenantId);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function assertDemoTenant(transaction: sql.Transaction, tenantId: string): Promise<void> {
  const lookup = await new sql.Request(transaction)
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .query<{ tenant_id: string; is_demo: boolean | number }>(
      `SELECT tenant_id, is_demo
       FROM dbo.tenant
       WHERE tenant_id = @tenant_id`
    );

  const row = lookup.recordset[0];
  if (!row) {
    throw new Error('Tenant not found');
  }
  if (!asBool(row.is_demo)) {
    throw new Error('Tenant is not a demo tenant');
  }
}

async function listDemoAccessMemberships(tenantId: string): Promise<DemoAccessSummary[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .query<{
      tenant_membership_id: string;
      tenant_id: string;
      user_id: string;
      email: string;
      display_name: string | null;
      role: string;
      membership_kind: string;
      status: string;
      starts_at: Date | string;
      expires_at: Date | string | null;
    }>(
      `SELECT
          tm.tenant_membership_id,
          tm.tenant_id,
          tm.user_id,
          u.email,
          u.display_name,
          tm.role,
          tm.membership_kind,
          tm.status,
          tm.starts_at,
          tm.expires_at
       FROM dbo.tenant_membership tm
       INNER JOIN dbo.[user] u
         ON u.user_id = tm.user_id
       WHERE tm.tenant_id = @tenant_id
         AND tm.membership_kind = 'temporary_demo'
         AND tm.status = 'active'
         AND tm.revoked_at IS NULL
         AND (tm.expires_at IS NULL OR tm.expires_at > GETUTCDATE())
       ORDER BY tm.expires_at ASC, u.email ASC`
    );

  return result.recordset.map((row) => ({
    tenant_membership_id: row.tenant_membership_id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    membership_kind: row.membership_kind,
    status: row.status,
    starts_at: asIso(row.starts_at) ?? new Date().toISOString(),
    expires_at: asIso(row.expires_at),
  }));
}

async function grantDemoAccessByEmail(input: GrantDemoAccessInput): Promise<DemoAccessSummary[]> {
  const tenantId = input.tenantId.trim();
  const normalizedEmail = normalizeEmail(input.email);
  const displayName = normalizeDisplayName(input.displayName) ?? normalizedEmail;
  const actorEmail = normalizeDisplayName(input.actorEmail) ? normalizeEmail(input.actorEmail as string) : normalizedEmail;
  const expiresAt = new Date(input.expiresAt);

  if (!normalizedEmail || !normalizedEmail.includes('@')) {
    throw new Error('Valid email is required');
  }
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error('expiresAt must be a valid ISO timestamp');
  }
  if (expiresAt.getTime() <= Date.now()) {
    throw new Error('expiresAt must be in the future');
  }

  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    await assertDemoTenant(transaction, tenantId);

    const actorLookup = await new sql.Request(transaction)
      .input('actor_email', sql.NVarChar(255), actorEmail)
      .query<{ user_id: string }>('SELECT TOP (1) user_id FROM dbo.[user] WHERE LOWER(email) = @actor_email');
    const actorUserId = actorLookup.recordset[0]?.user_id ?? null;

    const ensureUser = await new sql.Request(transaction)
      .input('email', sql.NVarChar(255), normalizedEmail)
      .input('display_name', sql.NVarChar(200), displayName)
      .query<{ user_id: string }>(
        `MERGE dbo.[user] AS target
         USING (SELECT @email AS email) AS src
            ON LOWER(target.email) = src.email
         WHEN MATCHED THEN
            UPDATE SET
              display_name = COALESCE(@display_name, target.display_name),
              is_active = 1,
              updated_at = GETUTCDATE()
         WHEN NOT MATCHED THEN
            INSERT (user_id, azure_oid, email, display_name, role, is_active, is_root, root_role, created_at, updated_at)
            VALUES (NEWID(), NULL, @email, @display_name, 'user', 1, 0, NULL, GETUTCDATE(), GETUTCDATE())
         OUTPUT INSERTED.user_id;`
      );

    const userId = ensureUser.recordset[0]?.user_id;
    if (!userId) {
      throw new Error('Failed to ensure user for demo access grant');
    }

    await new sql.Request(transaction)
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .input('user_id', sql.UniqueIdentifier, userId)
      .input('expires_at', sql.DateTime, expiresAt)
      .input('created_by_user_id', sql.UniqueIdentifier, actorUserId)
      .query(
        `IF EXISTS (
            SELECT 1
            FROM dbo.tenant_membership
            WHERE tenant_id = @tenant_id
              AND user_id = @user_id
              AND membership_kind = 'temporary_demo'
              AND status = 'active'
              AND revoked_at IS NULL
         )
           BEGIN
             UPDATE dbo.tenant_membership
             SET role = 'member',
                 starts_at = GETUTCDATE(),
                 expires_at = @expires_at,
                 revoked_at = NULL,
                 status = 'active'
             WHERE tenant_id = @tenant_id
               AND user_id = @user_id
               AND membership_kind = 'temporary_demo'
               AND status = 'active'
               AND revoked_at IS NULL;
           END
         ELSE
           BEGIN
             INSERT INTO dbo.tenant_membership (
               tenant_membership_id,
               tenant_id,
               user_id,
               member_id,
               role,
               membership_kind,
               home_tenant_id,
               starts_at,
               expires_at,
               status,
               created_by_user_id,
               created_at,
               revoked_at
             )
             VALUES (
               NEWID(),
               @tenant_id,
               @user_id,
               NULL,
               'member',
               'temporary_demo',
               NULL,
               GETUTCDATE(),
               @expires_at,
               'active',
               @created_by_user_id,
               GETUTCDATE(),
               NULL
             );
           END`
      );

    await transaction.commit();
    return listDemoAccessMemberships(tenantId);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function revokeDemoAccessMembership(tenantId: string, membershipId: string): Promise<DemoAccessSummary[]> {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    await assertDemoTenant(transaction, tenantId);
    await new sql.Request(transaction)
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .input('tenant_membership_id', sql.UniqueIdentifier, membershipId)
      .query(
        `UPDATE dbo.tenant_membership
         SET status = 'revoked',
             revoked_at = GETUTCDATE()
         WHERE tenant_membership_id = @tenant_membership_id
           AND tenant_id = @tenant_id
           AND membership_kind = 'temporary_demo'
           AND revoked_at IS NULL`
      );

    await transaction.commit();
    return listDemoAccessMemberships(tenantId);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function resetDemoAccessMemberships(tenantId: string): Promise<{ revoked_count: number; memberships: DemoAccessSummary[] }> {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    await assertDemoTenant(transaction, tenantId);

    const result = await new sql.Request(transaction)
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .query<{ revoked_count: number }>(
        `UPDATE dbo.tenant_membership
         SET status = 'revoked',
             revoked_at = GETUTCDATE()
         WHERE tenant_id = @tenant_id
           AND membership_kind = 'temporary_demo'
           AND status = 'active'
           AND revoked_at IS NULL;

         SELECT @@ROWCOUNT AS revoked_count;`
      );

    await transaction.commit();
    const memberships = await listDemoAccessMemberships(tenantId);
    return {
      revoked_count: Number(result.recordset[0]?.revoked_count ?? 0),
      memberships,
    };
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function revokeTenantAdminByUserId(tenantId: string, userId: string): Promise<TenantAdminSummary[]> {
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const tenantLookup = await new sql.Request(transaction)
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .query<{ tenant_id: string }>('SELECT tenant_id FROM dbo.tenant WHERE tenant_id = @tenant_id');
    if (!tenantLookup.recordset[0]) {
      throw new Error('Tenant not found');
    }

    await new sql.Request(transaction)
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .input('user_id', sql.UniqueIdentifier, userId)
      .query(
        `UPDATE dbo.tenant_membership
         SET status = 'revoked',
             revoked_at = GETUTCDATE()
         WHERE tenant_id = @tenant_id
           AND user_id = @user_id
           AND membership_kind = 'admin'
           AND status = 'active'
           AND revoked_at IS NULL`
      );

    await transaction.commit();
    return listTenantAdmins(tenantId);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

async function setTenantStatus(tenantId: string, status: TenantStatus): Promise<TenantSummary> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('status', sql.NVarChar(20), status)
    .query<TenantStatusRow>(
      `IF NOT EXISTS (SELECT 1 FROM dbo.tenant WHERE tenant_id = @tenant_id)
         THROW 50001, 'Tenant not found', 1;

       UPDATE dbo.tenant
       SET status = @status,
           is_operational = CASE
             WHEN @status = 'active' THEN CASE WHEN is_demo = 1 THEN 0 ELSE 1 END
             ELSE 0
           END
       WHERE tenant_id = @tenant_id;

       SELECT TOP (1)
         tenant_id,
         slug,
         display_name,
         tenant_type,
         status,
         timezone,
         is_demo,
         is_operational,
         created_at
       FROM dbo.tenant
       WHERE tenant_id = @tenant_id;`
    );

  const row = result.recordset[0];
  if (!row) {
    throw new Error('Tenant not found');
  }

  return {
    tenant_id: row.tenant_id,
    slug: row.slug,
    display_name: row.display_name,
    tenant_type: row.tenant_type,
    status: row.status,
    timezone: row.timezone,
    is_demo: asBool(row.is_demo),
    is_operational: asBool(row.is_operational),
    created_at: asIso(row.created_at) ?? new Date().toISOString(),
  };
}

async function getTenantUsageSummary(tenantId: string): Promise<TenantUsageSummary> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .query<{
      members_total: number;
      events_total: number;
      event_responses_total: number;
      notifications_total: number;
      notification_failures_total: number;
      email_opt_out_total: number;
      sms_opt_out_total: number;
    }>(
      `IF NOT EXISTS (SELECT 1 FROM dbo.tenant WHERE tenant_id = @tenant_id)
         THROW 50001, 'Tenant not found', 1;

       DECLARE @members_total BIGINT = 0;
       DECLARE @events_total BIGINT = 0;
       DECLARE @event_responses_total BIGINT = 0;
       DECLARE @notifications_total BIGINT = 0;
       DECLARE @notification_failures_total BIGINT = 0;
       DECLARE @email_opt_out_total BIGINT = 0;
       DECLARE @sms_opt_out_total BIGINT = 0;

       IF OBJECT_ID(N'dbo.member', N'U') IS NOT NULL
       BEGIN
         IF COL_LENGTH('dbo.member', 'tenant_id') IS NOT NULL
           SELECT @members_total = COUNT_BIG(*)
           FROM dbo.member
           WHERE tenant_id = @tenant_id
             AND is_active = 1;
         ELSE
           SELECT @members_total = COUNT_BIG(*)
           FROM dbo.member
           WHERE is_active = 1;
       END

       IF OBJECT_ID(N'dbo.event', N'U') IS NOT NULL
       BEGIN
         IF COL_LENGTH('dbo.event', 'tenant_id') IS NOT NULL
           SELECT @events_total = COUNT_BIG(*)
           FROM dbo.event
           WHERE tenant_id = @tenant_id;
         ELSE
           SELECT @events_total = COUNT_BIG(*)
           FROM dbo.event;
       END

       IF OBJECT_ID(N'dbo.event_response', N'U') IS NOT NULL
       BEGIN
         IF COL_LENGTH('dbo.event_response', 'tenant_id') IS NOT NULL
           SELECT @event_responses_total = COUNT_BIG(*)
           FROM dbo.event_response
           WHERE tenant_id = @tenant_id;
         ELSE
           SELECT @event_responses_total = COUNT_BIG(*)
           FROM dbo.event_response;
       END

       IF OBJECT_ID(N'dbo.notification_log', N'U') IS NOT NULL
       BEGIN
         IF COL_LENGTH('dbo.notification_log', 'tenant_id') IS NOT NULL
         BEGIN
           SELECT @notifications_total = COUNT_BIG(*)
           FROM dbo.notification_log
           WHERE tenant_id = @tenant_id;

           SELECT @notification_failures_total = COUNT_BIG(*)
           FROM dbo.notification_log
           WHERE tenant_id = @tenant_id
             AND LOWER(COALESCE(status, '')) = 'failed';
         END
         ELSE
         BEGIN
           SELECT @notifications_total = COUNT_BIG(*)
           FROM dbo.notification_log;

           SELECT @notification_failures_total = COUNT_BIG(*)
           FROM dbo.notification_log
           WHERE LOWER(COALESCE(status, '')) = 'failed';
         END
       END

       IF OBJECT_ID(N'dbo.email_preference_log', N'U') IS NOT NULL
       BEGIN
         IF COL_LENGTH('dbo.email_preference_log', 'tenant_id') IS NOT NULL
           SELECT @email_opt_out_total = COUNT_BIG(*)
           FROM dbo.email_preference_log
           WHERE tenant_id = @tenant_id
             AND action = 'opt_out';
         ELSE IF OBJECT_ID(N'dbo.member', N'U') IS NOT NULL AND COL_LENGTH('dbo.member', 'tenant_id') IS NOT NULL
           SELECT @email_opt_out_total = COUNT_BIG(*)
           FROM dbo.email_preference_log epl
           INNER JOIN dbo.member m ON m.member_id = epl.member_id
           WHERE m.tenant_id = @tenant_id
             AND epl.action = 'opt_out';
         ELSE
           SELECT @email_opt_out_total = COUNT_BIG(*)
           FROM dbo.email_preference_log
           WHERE action = 'opt_out';
       END

       IF OBJECT_ID(N'dbo.sms_consent_log', N'U') IS NOT NULL
       BEGIN
         IF COL_LENGTH('dbo.sms_consent_log', 'tenant_id') IS NOT NULL
           SELECT @sms_opt_out_total = COUNT_BIG(*)
           FROM dbo.sms_consent_log
           WHERE tenant_id = @tenant_id
             AND action = 'opt_out';
         ELSE IF OBJECT_ID(N'dbo.member', N'U') IS NOT NULL AND COL_LENGTH('dbo.member', 'tenant_id') IS NOT NULL
           SELECT @sms_opt_out_total = COUNT_BIG(*)
           FROM dbo.sms_consent_log scl
           INNER JOIN dbo.member m ON m.member_id = scl.member_id
           WHERE m.tenant_id = @tenant_id
             AND scl.action = 'opt_out';
         ELSE
           SELECT @sms_opt_out_total = COUNT_BIG(*)
           FROM dbo.sms_consent_log
           WHERE action = 'opt_out';
       END

       SELECT
         CAST(@members_total AS INT) AS members_total,
         CAST(@events_total AS INT) AS events_total,
         CAST(@event_responses_total AS INT) AS event_responses_total,
         CAST(@notifications_total AS INT) AS notifications_total,
         CAST(@notification_failures_total AS INT) AS notification_failures_total,
         CAST(@email_opt_out_total AS INT) AS email_opt_out_total,
         CAST(@sms_opt_out_total AS INT) AS sms_opt_out_total;`
    );

  const row = result.recordset[0] ?? {
    members_total: 0,
    events_total: 0,
    event_responses_total: 0,
    notifications_total: 0,
    notification_failures_total: 0,
    email_opt_out_total: 0,
    sms_opt_out_total: 0,
  };

  return {
    tenant_id: tenantId,
    members_total: Number(row.members_total ?? 0),
    events_total: Number(row.events_total ?? 0),
    event_responses_total: Number(row.event_responses_total ?? 0),
    notifications_total: Number(row.notifications_total ?? 0),
    notification_failures_total: Number(row.notification_failures_total ?? 0),
    email_opt_out_total: Number(row.email_opt_out_total ?? 0),
    sms_opt_out_total: Number(row.sms_opt_out_total ?? 0),
    calculated_at: new Date().toISOString(),
  };
}

export {
  createTenant,
  getTenantUsageSummary,
  grantDemoAccessByEmail,
  grantTenantAdminByEmail,
  listDemoAccessMemberships,
  listTenantAdmins,
  revokeTenantAdminByUserId,
  resetDemoAccessMemberships,
  setTenantStatus,
  revokeDemoAccessMembership,
};
export type {
  CreateTenantInput,
  DemoAccessSummary,
  GrantDemoAccessInput,
  TenantAdminSummary,
  TenantUsageSummary,
  TenantSummary,
};