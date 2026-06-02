import { apiDelete, apiGet, apiPost, apiPut } from './client'

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

type TenantBrandingAssetKind = 'logo' | 'logo_dark' | 'hero'
type SmsProvider = 'acs' | 'twilio' | 'telnyx' | null

interface RootTenantBranding {
  tenant_id: string
  org_long_name: string | null
  org_short_name: string | null
  support_email: string | null
  accessibility_email: string | null
  logo_url: string | null
  logo_dark_url: string | null
  hero_image_urls: string[]
  primary_color: string | null
  accent_color: string | null
  dark_color: string | null
  program_tagline: string | null
  portal_login_url: string | null
  mission_blurb: string | null
  created_at: string
  updated_at: string
}

interface RootBrandingUploadUrlResponse {
  upload_url: string
  blob_url: string
  blob_path: string
  expires_at: string
  required_headers: Record<string, string>
}

interface RootCreateTenantPayload {
  slug: string
  display_name: string
  tenant_type?: 'program' | 'demo' | 'system'
  status?: 'active' | 'suspended' | 'archived'
  timezone?: string
  is_demo?: boolean
  is_operational?: boolean
}

interface RootTenantAdminSummary {
  tenant_membership_id: string
  tenant_id: string
  user_id: string
  email: string
  display_name: string | null
  role: string
  membership_kind: string
  status: string
  starts_at: string
  expires_at: string | null
}

interface RootTenantMessaging {
  tenant_id: string
  email_from: string | null
  email_reply_to: string | null
  email_bcc_monitor: string | null
  sms_provider: SmsProvider
  sms_from: string | null
  twilio_messaging_service_sid: string | null
  telnyx_messaging_profile_id: string | null
  telnyx_from_number: string | null
  created_at: string
  updated_at: string
}

interface RootTenantUsageSummary {
  tenant_id: string
  members_total: number
  events_total: number
  event_responses_total: number
  notifications_total: number
  notification_failures_total: number
  email_opt_out_total: number
  sms_opt_out_total: number
  calculated_at: string
}

interface RootDemoMembershipSummary {
  tenant_membership_id: string
  tenant_id: string
  user_id: string
  email: string
  display_name: string | null
  role: string
  membership_kind: string
  status: string
  starts_at: string
  expires_at: string | null
}

const rootApi = {
  getSession: () => apiGet<RootSession>('/root/session'),
  listTenants: () => apiGet<{ tenants: RootTenantSummary[] }>('/root/tenants'),
  createTenant: (payload: RootCreateTenantPayload) => apiPost<RootTenantSummary>('/root/tenants', payload),
  listTenantAdmins: (tenantId: string) => apiGet<{ admins: RootTenantAdminSummary[] }>(`/root/tenants/${encodeURIComponent(tenantId)}/admins`),
  grantTenantAdmin: (tenantId: string, payload: { email: string; display_name?: string | null; expires_at?: string | null }) =>
    apiPost<{ admins: RootTenantAdminSummary[] }>(`/root/tenants/${encodeURIComponent(tenantId)}/admins`, payload),
  revokeTenantAdmin: (tenantId: string, userId: string) =>
    apiDelete<{ admins: RootTenantAdminSummary[] }>(`/root/tenants/${encodeURIComponent(tenantId)}/admins/${encodeURIComponent(userId)}`),
  setTenantSuspended: (tenantId: string, payload: { action: 'suspend' | 'reactivate' }) =>
    apiPost<{ tenant: RootTenantSummary; action: 'suspend' | 'reactivate' }>(`/root/tenants/${encodeURIComponent(tenantId)}/suspend`, payload),
  getTenantUsage: (tenantId: string) => apiGet<RootTenantUsageSummary>(`/root/tenants/${encodeURIComponent(tenantId)}/usage`),
  getTenantMessaging: (tenantId: string) => apiGet<RootTenantMessaging>(`/root/tenants/${encodeURIComponent(tenantId)}/messaging`),
  upsertTenantMessaging: (tenantId: string, payload: Partial<RootTenantMessaging>) =>
    apiPut<RootTenantMessaging>(`/root/tenants/${encodeURIComponent(tenantId)}/messaging`, payload),
  listDemoMemberships: (tenantId: string) =>
    apiGet<{ memberships: RootDemoMembershipSummary[] }>(`/root/tenants/${encodeURIComponent(tenantId)}/demo/memberships`),
  grantDemoMembership: (tenantId: string, payload: { email: string; display_name?: string | null; expires_at: string }) =>
    apiPost<{ memberships: RootDemoMembershipSummary[] }>(`/root/tenants/${encodeURIComponent(tenantId)}/demo/memberships`, payload),
  revokeDemoMembership: (tenantId: string, membershipId: string) =>
    apiDelete<{ memberships: RootDemoMembershipSummary[] }>(`/root/tenants/${encodeURIComponent(tenantId)}/demo/memberships/${encodeURIComponent(membershipId)}`),
  resetDemoMemberships: (tenantId: string) =>
    apiPost<{ revoked_count: number; memberships: RootDemoMembershipSummary[] }>(`/root/tenants/${encodeURIComponent(tenantId)}/demo/reset`, {}),
  getAccessProfile: (email: string) => apiGet<RootAccessProfile>(`/root/access?email=${encodeURIComponent(email)}`),
  upsertAccessProfile: (payload: RootAccessUpsertPayload) => apiPut<RootAccessProfile>('/root/access', payload),
  getTenantBranding: (tenantId: string) => apiGet<RootTenantBranding>(`/root/tenants/${encodeURIComponent(tenantId)}/branding`),
  upsertTenantBranding: (tenantId: string, payload: Partial<RootTenantBranding>) =>
    apiPut<RootTenantBranding>(`/root/tenants/${encodeURIComponent(tenantId)}/branding`, payload),
  createBrandingAssetUploadUrl: (tenantId: string, payload: { file_name: string; content_type: string; asset_kind: TenantBrandingAssetKind }) =>
    apiPost<RootBrandingUploadUrlResponse>(`/root/tenants/${encodeURIComponent(tenantId)}/branding/assets/upload-url`, payload),
  commitBrandingAsset: (tenantId: string, payload: { asset_kind: TenantBrandingAssetKind; asset_url: string }) =>
    apiPost<RootTenantBranding>(`/root/tenants/${encodeURIComponent(tenantId)}/branding/assets/commit`, payload),
}

export { rootApi }
export type {
  AppUserRole,
  MemberPersona,
  RootAccessMembershipSummary,
  RootAccessProfile,
  RootRole,
  RootSession,
  RootTenantAdminSummary,
  RootTenantBranding,
  RootCreateTenantPayload,
  RootDemoMembershipSummary,
  RootTenantMessaging,
  RootTenantUsageSummary,
  RootTenantSummary,
  SmsProvider,
  TenantBrandingAssetKind,
  TenantMembershipKind,
  TenantMembershipRole,
}
