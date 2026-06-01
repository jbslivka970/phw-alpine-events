import { apiGet } from './client';

type TenantRole = 'member' | 'admin' | 'event_creator' | 'tavf_creator' | 'support' | 'root_admin';
type MembershipKind = 'home' | 'temporary_demo' | 'admin';

interface TenantBranding {
  org_short_name: string | null;
  primary_color: string | null;
  logo_url: string | null;
}

interface UserTenantContext {
  tenant_id: string;
  slug: string;
  display_name: string;
  tenant_type: string;
  is_demo: boolean;
  role: TenantRole;
  membership_kind: MembershipKind;
  expires_at: string | null;
  branding: TenantBranding | null;
}

const meApi = {
  listTenants: (): Promise<UserTenantContext[]> => apiGet<UserTenantContext[]>('/me/tenants'),
};

export { meApi };
export type { TenantBranding, UserTenantContext, TenantRole, MembershipKind };
