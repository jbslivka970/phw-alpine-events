import { getPool, sql } from '../db';
import type { AppRole } from '../middleware/auth';

const DEFAULT_TENANT_ID = '1b6b9719-663a-4e56-8f7d-9a4bd4c10001';
const DEFAULT_TENANT_SLUG = 'colorado-alpine';
const DEFAULT_TENANT_NAME = 'Colorado Alpine';

type TenantRole = 'member' | 'admin' | 'event_creator' | 'tavf_creator' | 'support' | 'root_admin';
type MembershipKind = 'home' | 'temporary_demo' | 'admin';

interface TenantMembershipRow {
  tenant_id: string;
  slug: string;
  display_name: string;
  tenant_type: string;
  is_demo: boolean | number | null;
  role: TenantRole;
  membership_kind: MembershipKind;
  expires_at: Date | string | null;
  org_short_name: string | null;
  primary_color: string | null;
  logo_url: string | null;
}

export interface UserTenantContext {
  tenant_id: string;
  slug: string;
  display_name: string;
  tenant_type: string;
  is_demo: boolean;
  role: TenantRole;
  membership_kind: MembershipKind;
  expires_at: string | null;
  branding: {
    org_short_name: string | null;
    primary_color: string | null;
    logo_url: string | null;
  } | null;
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function requireExplicitTenantMembership(): boolean {
  return isTruthy(process.env['MULTI_TENANT_REQUIRE_MEMBERSHIP']);
}

function normalizeEmail(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeSubject(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  if (typeof value === 'string') {
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
  }

  return false;
}

function asIsoString(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function fallbackRoleFromAppRoles(roles: readonly AppRole[]): TenantRole {
  if (roles.includes('ADMIN')) {
    return 'admin';
  }
  if (roles.includes('EVENT_CREATOR')) {
    return 'event_creator';
  }
  if (roles.includes('TAVF_CREATOR')) {
    return 'tavf_creator';
  }
  return 'member';
}

function buildFallbackTenantContext(roles: readonly AppRole[]): UserTenantContext {
  return {
    tenant_id: DEFAULT_TENANT_ID,
    slug: DEFAULT_TENANT_SLUG,
    display_name: DEFAULT_TENANT_NAME,
    tenant_type: 'program',
    is_demo: false,
    role: fallbackRoleFromAppRoles(roles),
    membership_kind: 'home',
    expires_at: null,
    branding: null,
  };
}

function mapTenantMembershipRow(row: TenantMembershipRow): UserTenantContext {
  const branding = row.org_short_name || row.primary_color || row.logo_url
    ? {
      org_short_name: row.org_short_name,
      primary_color: row.primary_color,
      logo_url: row.logo_url,
    }
    : null;

  return {
    tenant_id: row.tenant_id,
    slug: row.slug,
    display_name: row.display_name,
    tenant_type: row.tenant_type,
    is_demo: asBoolean(row.is_demo),
    role: row.role,
    membership_kind: row.membership_kind,
    expires_at: asIsoString(row.expires_at),
    branding,
  };
}

export async function listTenantsForAuthenticatedUser(input: {
  sub?: string;
  email?: string;
  roles: readonly AppRole[];
}): Promise<UserTenantContext[]> {
  const subject = normalizeSubject(input.sub);
  const normalizedEmail = normalizeEmail(input.email);

  if (!subject && !normalizedEmail) {
    return [buildFallbackTenantContext(input.roles)];
  }

  const pool = await getPool();
  const tablesResult = await pool.request().query<{ tenant_tables_ready: number }>(`
    SELECT CASE
      WHEN OBJECT_ID(N'dbo.tenant', N'U') IS NOT NULL
       AND OBJECT_ID(N'dbo.tenant_membership', N'U') IS NOT NULL
      THEN 1 ELSE 0
    END AS tenant_tables_ready
  `);

  const tablesReady = Number(tablesResult.recordset?.[0]?.tenant_tables_ready ?? 0) === 1;
  if (!tablesReady) {
    return [buildFallbackTenantContext(input.roles)];
  }

  try {
    const request = pool.request();
    request.input('entra_object_id', sql.NVarChar(255), subject);
    request.input('normalized_email', sql.NVarChar(255), normalizedEmail);

    const membershipResult = await request.query<TenantMembershipRow>(`
      ;WITH candidate_users AS (
        SELECT DISTINCT u.user_id
        FROM dbo.[user] u
        WHERE u.is_active = 1
          AND (
            (@entra_object_id IS NOT NULL AND u.azure_oid = @entra_object_id)
            OR (@normalized_email IS NOT NULL AND LOWER(u.email) = @normalized_email)
          )
      ),
      candidate_members AS (
        SELECT DISTINCT m.member_id
        FROM dbo.member m
        LEFT JOIN dbo.member_identity_link mil
          ON mil.member_id = m.member_id
         AND mil.status IN ('pending', 'invited', 'linked')
        WHERE m.is_active = 1
          AND (
            (@normalized_email IS NOT NULL AND LOWER(m.email) = @normalized_email)
            OR (@normalized_email IS NOT NULL AND LOWER(mil.last_seen_email) = @normalized_email)
            OR (@entra_object_id IS NOT NULL AND mil.entra_object_id = @entra_object_id)
          )
      )
      SELECT DISTINCT
        tm.tenant_id,
        t.slug,
        t.display_name,
        t.tenant_type,
        t.is_demo,
        tm.role,
        tm.membership_kind,
        tm.expires_at,
        tb.org_short_name,
        tb.primary_color,
        tb.logo_url
      FROM dbo.tenant_membership tm
      INNER JOIN dbo.tenant t
        ON t.tenant_id = tm.tenant_id
      LEFT JOIN dbo.tenant_branding tb
        ON tb.tenant_id = t.tenant_id
      WHERE tm.status = 'active'
        AND tm.starts_at <= GETUTCDATE()
        AND (tm.expires_at IS NULL OR tm.expires_at > GETUTCDATE())
        AND (
          (tm.user_id IS NOT NULL AND tm.user_id IN (SELECT user_id FROM candidate_users))
          OR (tm.member_id IS NOT NULL AND tm.member_id IN (SELECT member_id FROM candidate_members))
        )
      ORDER BY
        CASE tm.membership_kind
          WHEN 'home' THEN 0
          WHEN 'temporary_demo' THEN 1
          ELSE 2
        END,
        t.display_name ASC
    `);

    const tenants = membershipResult.recordset.map(mapTenantMembershipRow);
    if (tenants.length > 0) {
      return tenants;
    }

    if (isTruthy(process.env['MULTI_TENANT_ENABLED']) && requireExplicitTenantMembership()) {
      return [];
    }

    return [buildFallbackTenantContext(input.roles)];
  } catch (error) {
    if (!isTruthy(process.env['MULTI_TENANT_ENABLED']) || !requireExplicitTenantMembership()) {
      console.warn('[tenant-context] Falling back to default tenant profile after query failure');
      return [buildFallbackTenantContext(input.roles)];
    }
    throw error;
  }
}
