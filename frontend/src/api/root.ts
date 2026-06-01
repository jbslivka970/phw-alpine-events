import { apiGet, apiPut } from './client'

type AppUserRole = 'admin' | 'superadmin' | 'event_creator' | 'tavf_creator' | 'user'
type RootRole = 'root_admin' | 'support'
type TenantMembershipRole = 'member' | 'admin' | 'event_creator' | 'tavf_creator' | 'support' | 'root_admin'
type TenantMembershipKind = 'home' | 'temporary_demo' | 'admin'
type MemberPersona = 'participant' | 'volunteer' | 'mentor' | 'guide' | 'staff'

interface RootSession {
  user_id: string
  email: string
  display_name: string | null
  role: AppUserRole
  is_root: boolean
  root_role: RootRole | null
}

interface RootTenantSummary {
  tenant_id: string
  slug: string
  display_name: string
  tenant_type: string
  is_demo: boolean
  status: string | null
}

interface RootAccessMembershipSummary {
  tenant_membership_id: string
  tenant_id: string
  tenant_slug: string
  tenant_name: string
  role: TenantMembershipRole
  membership_kind: TenantMembershipKind
  status: string
  starts_at: string
  expires_at: string | null
  subject_type: 'user' | 'member'
}

interface RootAccessProfile {
  email: string
  user: {
    user_id: string
    email: string
    display_name: string | null
    role: AppUserRole
    is_active: boolean
    is_root: boolean
    root_role: RootRole | null
  } | null
  member: {
    member_id: string
    email: string
    first_name: string | null
    last_name: string | null
    is_active: boolean
  } | null
  tenant_memberships: RootAccessMembershipSummary[]
  personas: MemberPersona[]
  groups: string[]
}

interface RootAccessUpsertPayload {
  email: string
  display_name?: string | null
  app_role: AppUserRole
  is_root: boolean
  root_role?: RootRole | null
  ensure_member?: boolean
  first_name?: string | null
  last_name?: string | null
  personas?: MemberPersona[]
  tenant_memberships?: Array<{
    tenant_id: string
    role: TenantMembershipRole
    membership_kind: TenantMembershipKind
    expires_at?: string | null
  }>
}

const rootApi = {
  getSession: () => apiGet<RootSession>('/root/session'),
  listTenants: () => apiGet<{ tenants: RootTenantSummary[] }>('/root/tenants'),
  getAccessProfile: (email: string) => apiGet<RootAccessProfile>(`/root/access?email=${encodeURIComponent(email)}`),
  upsertAccessProfile: (payload: RootAccessUpsertPayload) => apiPut<RootAccessProfile>('/root/access', payload),
}

export { rootApi }
export type {
  AppUserRole,
  MemberPersona,
  RootAccessMembershipSummary,
  RootAccessProfile,
  RootRole,
  RootSession,
  RootTenantSummary,
  TenantMembershipKind,
  TenantMembershipRole,
}
