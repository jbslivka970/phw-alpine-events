import { getPool, sql } from '../db';

type AppUserRole = 'admin' | 'superadmin' | 'event_creator' | 'tavf_creator' | 'user';
type TenantMembershipRole = 'member' | 'admin' | 'event_creator' | 'tavf_creator' | 'support' | 'root_admin';
type TenantMembershipKind = 'home' | 'temporary_demo' | 'admin';
type RootRole = 'root_admin' | 'support';
type MemberPersona = 'participant' | 'volunteer' | 'mentor' | 'guide' | 'staff';

interface RootSessionRow {
  user_id: string;
  email: string;
  display_name: string | null;
  role: AppUserRole;
  is_root: boolean | number | null;
  root_role: RootRole | null;
}

interface TenantRow {
  tenant_id: string;
  slug: string;
  display_name: string;
  tenant_type: string;
  is_demo: boolean | number | null;
  status: string | null;
}

interface AccessMembershipRow {
  tenant_membership_id: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  role: TenantMembershipRole;
  membership_kind: TenantMembershipKind;
  status: string;
  starts_at: Date | string;
  expires_at: Date | string | null;
  user_id: string | null;
  member_id: string | null;
}

interface RootAccessUserRow {
  user_id: string;
  email: string;
  display_name: string | null;
  role: AppUserRole;
  is_active: boolean | number | null;
  is_root: boolean | number | null;
  root_role: RootRole | null;
}

interface RootAccessMemberRow {
  member_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  is_active: boolean | number | null;
}

interface RootAccessPersonaRow {
  persona: MemberPersona;
}

interface RootAccessGroupRow {
  group_name: string;
}

interface RootSession {
  user_id: string;
  email: string;
  display_name: string | null;
  role: AppUserRole;
  is_root: boolean;
  root_role: RootRole | null;
}

interface RootTenantSummary {
  tenant_id: string;
  slug: string;
  display_name: string;
  tenant_type: string;
  is_demo: boolean;
  status: string | null;
}

interface RootAccessMembershipSummary {
  tenant_membership_id: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_name: string;
  role: TenantMembershipRole;
  membership_kind: TenantMembershipKind;
  status: string;
  starts_at: string;
  expires_at: string | null;
  subject_type: 'user' | 'member';
}

interface RootAccessProfile {
  email: string;
  user: {
    user_id: string;
    email: string;
    display_name: string | null;
    role: AppUserRole;
    is_active: boolean;
    is_root: boolean;
    root_role: RootRole | null;
  } | null;
  member: {
    member_id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    is_active: boolean;
  } | null;
  tenant_memberships: RootAccessMembershipSummary[];
  personas: MemberPersona[];
  groups: string[];
}

interface DesiredTenantMembershipInput {
  tenant_id: string;
  role: TenantMembershipRole;
  membership_kind: TenantMembershipKind;
  expires_at?: string | null;
}

interface UpsertRootAccessInput {
  email: string;
  display_name?: string | null;
  app_role: AppUserRole;
  is_root: boolean;
  root_role?: RootRole | null;
  ensure_member?: boolean;
  first_name?: string | null;
  last_name?: string | null;
  personas?: MemberPersona[];
  tenant_memberships?: DesiredTenantMembershipInput[];
  updated_by_email: string;
}

function asBoolean(value: boolean | number | null | undefined): boolean {
  return value === true || value === 1;
}

function asIsoString(value: Date | string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeNamePart(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function splitDisplayName(displayName: string | null | undefined): { firstName: string; lastName: string } {
  const normalized = normalizeNamePart(displayName) ?? 'Root Admin';
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: 'Member' };
  }
  return {
    firstName: parts[0] ?? 'Root',
    lastName: parts.slice(1).join(' ') || 'Member',
  };
}

async function getRootSession(input: { sub?: string; email?: string }): Promise<RootSession | null> {
  const subject = input.sub?.trim() ?? null;
  const normalizedEmail = input.email ? normalizeEmail(input.email) : null;
  if (!subject && !normalizedEmail) {
    return null;
  }

  const pool = await getPool();
  const result = await pool
    .request()
    .input('oid', sql.NVarChar(255), subject)
    .input('email', sql.NVarChar(255), normalizedEmail)
    .query<RootSessionRow>(
      `SELECT TOP (1)
          user_id,
          email,
          display_name,
          role,
          is_root,
          root_role
       FROM dbo.[user]
       WHERE is_active = 1
         AND ((@oid IS NOT NULL AND azure_oid = @oid) OR (@email IS NOT NULL AND LOWER(email) = @email))`
    );

  const row = result.recordset[0];
  if (!row) {
    return null;
  }

  return {
    user_id: row.user_id,
    email: row.email,
    display_name: row.display_name,
    role: row.role,
    is_root: asBoolean(row.is_root),
    root_role: row.root_role,
  };
}

async function listTenantsForRoot(): Promise<RootTenantSummary[]> {
  const pool = await getPool();
  const result = await pool.request().query<TenantRow>(
    `SELECT tenant_id, slug, display_name, tenant_type, is_demo, status
     FROM dbo.tenant
     ORDER BY CASE WHEN slug = 'colorado-alpine' THEN 0 ELSE 1 END, display_name ASC`
  );

  return result.recordset.map((row) => ({
    tenant_id: row.tenant_id,
    slug: row.slug,
    display_name: row.display_name,
    tenant_type: row.tenant_type,
    is_demo: asBoolean(row.is_demo),
    status: row.status,
  }));
}

async function getRootAccessProfileByEmail(email: string): Promise<RootAccessProfile> {
  const normalizedEmail = normalizeEmail(email);
  const pool = await getPool();
  const request = pool.request().input('email', sql.NVarChar(255), normalizedEmail);

  const result = await request.query(
    `SELECT TOP (1)
        user_id,
        email,
        display_name,
        role,
        is_active,
        is_root,
        root_role
     FROM dbo.[user]
     WHERE LOWER(email) = @email;

     SELECT TOP (1)
        member_id,
        email,
        first_name,
        last_name,
        is_active
     FROM dbo.member
     WHERE LOWER(email) = @email
     ORDER BY created_at ASC, member_id ASC;

     SELECT
        tm.tenant_membership_id,
        tm.tenant_id,
        t.slug AS tenant_slug,
        t.display_name AS tenant_name,
        tm.role,
        tm.membership_kind,
        tm.status,
        tm.starts_at,
        tm.expires_at,
        tm.user_id,
        tm.member_id
     FROM dbo.tenant_membership tm
     INNER JOIN dbo.tenant t ON t.tenant_id = tm.tenant_id
     LEFT JOIN dbo.[user] u ON u.user_id = tm.user_id
     LEFT JOIN dbo.member m ON m.member_id = tm.member_id
     WHERE ((u.user_id IS NOT NULL AND LOWER(u.email) = @email)
        OR (m.member_id IS NOT NULL AND LOWER(m.email) = @email))
       AND tm.status = 'active'
       AND tm.revoked_at IS NULL
     ORDER BY t.display_name ASC, tm.role ASC;

     SELECT mp.persona
     FROM dbo.member_persona mp
     INNER JOIN dbo.member m ON m.member_id = mp.member_id
     WHERE LOWER(m.email) = @email
     ORDER BY mp.persona ASC;

     SELECT g.group_name
     FROM dbo.member_group mg
     INNER JOIN dbo.member m ON m.member_id = mg.member_id
     INNER JOIN dbo.[group] g ON g.group_id = mg.group_id
     WHERE LOWER(m.email) = @email
     ORDER BY g.group_name ASC;`
  ) as unknown as {
    recordsets: [
      RootAccessUserRow[],
      RootAccessMemberRow[],
      AccessMembershipRow[],
      RootAccessPersonaRow[],
      RootAccessGroupRow[],
    ];
  };

  const userRow = result.recordsets[0][0];
  const memberRow = result.recordsets[1][0];
  const membershipRows = result.recordsets[2];
  const personaRows = result.recordsets[3];
  const groupRows = result.recordsets[4];

  return {
    email: normalizedEmail,
    user: userRow ? {
      user_id: userRow.user_id,
      email: userRow.email,
      display_name: userRow.display_name,
      role: userRow.role,
      is_active: asBoolean(userRow.is_active),
      is_root: asBoolean(userRow.is_root),
      root_role: userRow.root_role,
    } : null,
    member: memberRow ? {
      member_id: memberRow.member_id,
      email: memberRow.email,
      first_name: memberRow.first_name,
      last_name: memberRow.last_name,
      is_active: asBoolean(memberRow.is_active),
    } : null,
    tenant_memberships: membershipRows.map((row) => ({
      tenant_membership_id: row.tenant_membership_id,
      tenant_id: row.tenant_id,
      tenant_slug: row.tenant_slug,
      tenant_name: row.tenant_name,
      role: row.role,
      membership_kind: row.membership_kind,
      status: row.status,
      starts_at: asIsoString(row.starts_at) ?? new Date(0).toISOString(),
      expires_at: asIsoString(row.expires_at),
      subject_type: row.user_id ? 'user' : 'member',
    })),
    personas: personaRows.map((row) => row.persona),
    groups: groupRows.map((row) => row.group_name),
  };
}

async function ensureTenantExists(poolRequest: sql.Request, tenantId: string): Promise<void> {
  const tenantLookup = await poolRequest
    .input('tenant_id_lookup', sql.UniqueIdentifier, tenantId)
    .query<{ tenant_id: string }>('SELECT tenant_id FROM dbo.tenant WHERE tenant_id = @tenant_id_lookup');

  if (!tenantLookup.recordset[0]) {
    throw new Error(`Unknown tenant_id: ${tenantId}`);
  }
}

async function upsertRootAccessProfile(input: UpsertRootAccessInput): Promise<RootAccessProfile> {
  const normalizedEmail = normalizeEmail(input.email);
  const normalizedDisplayName = normalizeNamePart(input.display_name) ?? normalizedEmail;
  const requestedRootRole = input.is_root ? (input.root_role ?? 'root_admin') : null;
  const personaSet = new Set<MemberPersona>((input.personas ?? []).filter(Boolean));
  const desiredMemberships = input.tenant_memberships;
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();

  try {
    const actorRequest = new sql.Request(transaction)
      .input('actor_email', sql.NVarChar(255), normalizeEmail(input.updated_by_email));
    const actorLookup = await actorRequest.query<{ user_id: string }>(
      `SELECT TOP (1) user_id FROM dbo.[user] WHERE LOWER(email) = @actor_email`
    );
    const actorUserId = actorLookup.recordset[0]?.user_id ?? null;

    const displayNameParts = splitDisplayName(normalizedDisplayName);
    const firstName = normalizeNamePart(input.first_name) ?? displayNameParts.firstName;
    const lastName = normalizeNamePart(input.last_name) ?? displayNameParts.lastName;

    const ensureUserRequest = await new sql.Request(transaction)
      .input('email', sql.NVarChar(255), normalizedEmail)
      .input('display_name', sql.NVarChar(200), normalizedDisplayName)
      .input('app_role', sql.NVarChar(20), input.app_role)
      .input('is_root', sql.Bit, input.is_root ? 1 : 0)
      .input('root_role', sql.NVarChar(20), requestedRootRole)
      .query<{ user_id: string }>(
        `MERGE dbo.[user] AS target
         USING (SELECT @email AS email) AS src
           ON LOWER(target.email) = src.email
         WHEN MATCHED THEN
           UPDATE SET
             display_name = COALESCE(@display_name, target.display_name),
             role = @app_role,
             is_active = 1,
             is_root = @is_root,
             root_role = @root_role,
             updated_at = GETUTCDATE()
         WHEN NOT MATCHED THEN
           INSERT (user_id, azure_oid, email, display_name, role, is_active, is_root, root_role, created_at, updated_at)
           VALUES (NEWID(), NULL, @email, @display_name, @app_role, 1, @is_root, @root_role, GETUTCDATE(), GETUTCDATE())
         OUTPUT INSERTED.user_id;`
      );
    const userId = ensureUserRequest.recordset[0]?.user_id;
    if (!userId) {
      throw new Error('Failed to upsert user access profile.');
    }

    let memberId: string | null = null;
    if (input.ensure_member || personaSet.size > 0 || (desiredMemberships?.some((membership) => membership.role === 'member') ?? false)) {
      const ensureMemberRequest = await new sql.Request(transaction)
        .input('email', sql.NVarChar(255), normalizedEmail)
        .input('first_name', sql.NVarChar(100), firstName)
        .input('last_name', sql.NVarChar(100), lastName)
        .query<{ member_id: string }>(
          `IF EXISTS (SELECT 1 FROM dbo.member WHERE LOWER(email) = @email)
             BEGIN
               UPDATE dbo.member
               SET is_active = 1,
                   first_name = COALESCE(NULLIF(first_name, ''), @first_name),
                   last_name = COALESCE(NULLIF(last_name, ''), @last_name),
                   updated_at = GETUTCDATE()
               OUTPUT INSERTED.member_id
               WHERE LOWER(email) = @email;
             END
           ELSE
             BEGIN
               INSERT INTO dbo.member (member_id, first_name, last_name, email, is_active, created_at, updated_at)
               OUTPUT INSERTED.member_id
               VALUES (NEWID(), @first_name, @last_name, @email, 1, GETUTCDATE(), GETUTCDATE());
             END`
        );
      memberId = ensureMemberRequest.recordset[0]?.member_id ?? null;
    }

    if (memberId) {
      const currentPersonasResult = await new sql.Request(transaction)
        .input('member_id', sql.UniqueIdentifier, memberId)
        .query<{ persona: MemberPersona }>('SELECT persona FROM dbo.member_persona WHERE member_id = @member_id');
      const currentPersonas = new Set(currentPersonasResult.recordset.map((row) => row.persona));

      for (const persona of personaSet) {
        if (currentPersonas.has(persona)) {
          continue;
        }
        await new sql.Request(transaction)
          .input('member_id', sql.UniqueIdentifier, memberId)
          .input('persona', sql.NVarChar(40), persona)
          .input('granted_by', sql.UniqueIdentifier, actorUserId)
          .query(
            `INSERT INTO dbo.member_persona (member_id, persona, granted_at, granted_by, notes)
             VALUES (@member_id, @persona, GETUTCDATE(), @granted_by, 'Root access admin update')`
          );
      }

      for (const persona of currentPersonas) {
        if (personaSet.has(persona)) {
          continue;
        }
        await new sql.Request(transaction)
          .input('member_id', sql.UniqueIdentifier, memberId)
          .input('persona', sql.NVarChar(40), persona)
          .query('DELETE FROM dbo.member_persona WHERE member_id = @member_id AND persona = @persona');
      }
    }

    const normalizedMemberships = (desiredMemberships ?? []).map((membership) => ({
      tenant_id: membership.tenant_id,
      role: membership.role,
      membership_kind: membership.membership_kind,
      expires_at: membership.expires_at?.trim() ? membership.expires_at : null,
      subject_type: membership.role === 'member' ? 'member' as const : 'user' as const,
    }));

    for (const membership of normalizedMemberships) {
      await ensureTenantExists(new sql.Request(transaction), membership.tenant_id);

      const subjectUserId = membership.subject_type === 'user' ? userId : null;
      const subjectMemberId = membership.subject_type === 'member' ? memberId : null;
      if (membership.subject_type === 'member' && !subjectMemberId) {
        throw new Error(`Cannot grant member-scoped access for ${normalizedEmail} without a member record.`);
      }

      await new sql.Request(transaction)
        .input('tenant_id', sql.UniqueIdentifier, membership.tenant_id)
        .input('user_id', sql.UniqueIdentifier, subjectUserId)
        .input('member_id', sql.UniqueIdentifier, subjectMemberId)
        .input('role', sql.NVarChar(30), membership.role)
        .input('membership_kind', sql.NVarChar(30), membership.membership_kind)
        .input('home_tenant_id', sql.UniqueIdentifier, membership.membership_kind === 'home' ? membership.tenant_id : null)
        .input('expires_at', sql.DateTime, membership.expires_at ? new Date(membership.expires_at) : null)
        .input('created_by_user_id', sql.UniqueIdentifier, actorUserId)
        .query(
          `IF EXISTS (
              SELECT 1
              FROM dbo.tenant_membership
              WHERE tenant_id = @tenant_id
                AND membership_kind = @membership_kind
                AND status = 'active'
                AND revoked_at IS NULL
                AND ((@user_id IS NOT NULL AND user_id = @user_id) OR (@member_id IS NOT NULL AND member_id = @member_id))
           )
             BEGIN
               UPDATE dbo.tenant_membership
               SET role = @role,
                   expires_at = @expires_at,
                   home_tenant_id = @home_tenant_id,
                   revoked_at = NULL
               WHERE tenant_id = @tenant_id
                 AND membership_kind = @membership_kind
                 AND status = 'active'
                 AND revoked_at IS NULL
                 AND ((@user_id IS NOT NULL AND user_id = @user_id) OR (@member_id IS NOT NULL AND member_id = @member_id));
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
                 @member_id,
                 @role,
                 @membership_kind,
                 @home_tenant_id,
                 GETUTCDATE(),
                 @expires_at,
                 'active',
                 @created_by_user_id,
                 GETUTCDATE(),
                 NULL
               );
             END`
        );
    }

    if (desiredMemberships) {
      const desiredUserMembershipKeys = new Set(
        normalizedMemberships
          .filter((membership) => membership.subject_type === 'user')
          .map((membership) => `${membership.tenant_id}:${membership.membership_kind}`)
      );
      const desiredMemberMembershipKeys = new Set(
        normalizedMemberships
          .filter((membership) => membership.subject_type === 'member')
          .map((membership) => `${membership.tenant_id}:${membership.membership_kind}`)
      );

      const activeMemberships = await new sql.Request(transaction)
        .input('user_id', sql.UniqueIdentifier, userId)
        .input('member_id', sql.UniqueIdentifier, memberId)
        .query<{ tenant_membership_id: string; tenant_id: string; membership_kind: TenantMembershipKind; user_id: string | null; member_id: string | null }>(
          `SELECT tenant_membership_id, tenant_id, membership_kind, user_id, member_id
           FROM dbo.tenant_membership
           WHERE status = 'active'
             AND revoked_at IS NULL
             AND ((@user_id IS NOT NULL AND user_id = @user_id) OR (@member_id IS NOT NULL AND member_id = @member_id))`
        );

      for (const membership of activeMemberships.recordset) {
        const key = `${membership.tenant_id}:${membership.membership_kind}`;
        const shouldKeep = membership.user_id
          ? desiredUserMembershipKeys.has(key)
          : desiredMemberMembershipKeys.has(key);

        if (shouldKeep) {
          continue;
        }

        await new sql.Request(transaction)
          .input('tenant_membership_id', sql.UniqueIdentifier, membership.tenant_membership_id)
          .query(
            `UPDATE dbo.tenant_membership
             SET status = 'revoked',
                 revoked_at = GETUTCDATE()
             WHERE tenant_membership_id = @tenant_membership_id`
          );
      }
    }

    await transaction.commit();
    return getRootAccessProfileByEmail(normalizedEmail);
  } catch (error) {
    await transaction.rollback();
    throw error;
  }
}

export {
  getRootAccessProfileByEmail,
  getRootSession,
  listTenantsForRoot,
  upsertRootAccessProfile,
};

export type {
  AppUserRole,
  DesiredTenantMembershipInput,
  MemberPersona,
  RootAccessProfile,
  RootSession,
  RootTenantSummary,
  TenantMembershipKind,
  TenantMembershipRole,
  UpsertRootAccessInput,
};

export type { RootRole };
