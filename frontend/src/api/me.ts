import { apiGetWithoutTenant } from './client';

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

type TenantListResponse = {
  tenants: UserTenantContext[];
} | UserTenantContext[];

function unwrapTenantList(response: TenantListResponse): UserTenantContext[] {
  if (Array.isArray(response)) {
    return response;
  }

  return Array.isArray(response.tenants) ? response.tenants : [];
}

const meApi = {
  listTenants: async (): Promise<UserTenantContext[]> => {
    const response = await apiGetWithoutTenant<TenantListResponse>('/me/tenants');
    return unwrapTenantList(response);
  },
};

export { meApi };
export type { TenantBranding, UserTenantContext, TenantRole, MembershipKind };
