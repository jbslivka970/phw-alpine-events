import { apiDelete, apiGet, apiPost, apiPut } from './client';

interface InviteDraftRequest {
  event_id?: string;
  title?: string;
  event_date?: string;
  location?: string | null;
  description?: string | null;
  tone?: 'friendly' | 'professional';
}

interface InviteDraftResponse {
  subject: string;
  emailBody: string;
  smsBody: string;
  provider: 'azure-openai' | 'openai' | 'fallback';
  source: 'event' | 'ad_hoc';
  tone: 'friendly' | 'professional';
}

interface ApplyInviteDraftRequest extends InviteDraftRequest {
  template_name?: string;
  subject?: string;
  emailBody?: string;
  smsBody?: string;
  approved: boolean;
  review_note?: string;
}

interface ApplyInviteDraftResponse {
  template_name: string;
  source: 'event' | 'ad_hoc';
  tone: 'friendly' | 'professional';
  provider: 'azure-openai' | 'openai' | 'fallback';
  approved: boolean;
  review_note: string | null;
  applied_by: string;
  applied_at: string;
  templates: {
    email: { template_id: string; updated_at: string };
    sms: { template_id: string; updated_at: string };
  };
}

interface RetentionPreviewRequest {
  notification_log_days?: number;
  inbound_sms_log_days?: number;
  email_preference_log_days?: number;
}

interface RetentionPreviewResult {
  target: 'notification_log' | 'inbound_sms_log' | 'email_preference_log';
  retentionDays: number;
  affectedRows: number;
  mode: 'dry-run';
}

interface RetentionPreviewResponse {
  generated_at: string;
  generated_by: string;
  mode: 'dry-run';
  results: RetentionPreviewResult[];
}

interface IdentityStatus {
  member_id: string;
  status: 'pending' | 'invited' | 'linked' | 'disabled';
  identity_provider: string | null;
  entra_object_id: string | null;
  issuer: string | null;
  issuer_assigned_id: string | null;
  invited_at: string | null;
  invite_email_sent_at: string | null;
  linked_at: string | null;
  last_sign_in_at: string | null;
  updated_at: string | null;
}

interface BulkIdentityStatusResponse {
  data: IdentityStatus[];
}

interface IdentityStatusSummaryResponse {
  total_members: number;
  pending: number;
  invited: number;
  access: number;
  signed_in: number;
  disabled: number;
}

interface InviteIdentityResponse {
  member_id: string;
  email: string;
  status: 'invited';
  invitation_id: string | null;
  invited_user_id: string | null;
  invite_redeem_url: string | null;
}

interface BulkInviteIdentityResponse {
  results: Array<{
    member_id: string;
    status: 'invited' | 'skipped' | 'failed';
    reason?: string;
  }>;
}

interface SupportEmailRelayConfig {
  supportInboxEmail: string;
  relayRecipients: string[];
  enabled: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

interface AdminUser {
  user_id: string;
  azure_oid: string | null;
  email: string;
  display_name: string | null;
  role: 'admin' | 'superadmin' | 'event_creator' | 'tavf_creator' | 'user';
  is_active: boolean;
  last_login: string | null;
  created_at: string;
  updated_at: string;
}

interface AdminUsersResponse {
  data: AdminUser[];
  total: number;
  page: number;
  pageSize: number;
}

interface AppRoleAvailable {
  id: string;
  value: string;
  displayName: string;
}

interface UserRoleAssignment {
  assignmentId: string;
  userObjectId: string;
  appRoleId: string;
  roleName: string;
}

interface UserRoleAssignmentsResponse {
  email: string;
  assignments: UserRoleAssignment[];
}

const adminApi = {
  generateInviteDraft: (payload: InviteDraftRequest) =>
    apiPost<InviteDraftResponse>('/admin/ai/invite-draft', payload),
  applyInviteDraftToTemplates: (payload: ApplyInviteDraftRequest) =>
    apiPost<ApplyInviteDraftResponse>('/admin/ai/invite-draft/apply', payload),
  previewRetention: (payload: RetentionPreviewRequest) =>
    apiPost<RetentionPreviewResponse>('/admin/retention/preview', payload),
  identityStatus: (memberId: string) =>
    apiGet<IdentityStatus>(`/admin/identity/status/${memberId}`),
  identityStatusBulk: (memberIds: string[]) =>
    apiPost<BulkIdentityStatusResponse>('/admin/identity/status/bulk', { member_ids: memberIds }),
  identityStatusSummary: () =>
    apiGet<IdentityStatusSummaryResponse>('/admin/identity/status/summary'),
  inviteIdentity: (memberId: string, redirectUrl?: string) =>
    apiPost<InviteIdentityResponse>('/admin/identity/invite', {
      member_id: memberId,
      ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    }),
  inviteIdentityBulk: (memberIds: string[], redirectUrl?: string) =>
    apiPost<BulkInviteIdentityResponse>('/admin/identity/invite/bulk', {
      member_ids: memberIds,
      ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    }),
  relinkIdentity: (payload: {
    member_id: string;
    email?: string;
    entra_object_id?: string;
    issuer?: string;
    issuer_assigned_id?: string;
    identity_provider?: string;
  }) => apiPost<IdentityStatus>('/admin/identity/relink', payload),
  getSupportEmailRelayConfig: () =>
    apiGet<SupportEmailRelayConfig>('/support/relay-config'),
  updateSupportEmailRelayConfig: (payload: {
    support_inbox_email: string;
    relay_to: string[];
    enabled: boolean;
  }) => apiPut<SupportEmailRelayConfig>('/support/relay-config', payload),
  listAdminUsers: (params?: {
    page?: number;
    pageSize?: number;
    search?: string;
    role?: 'admin' | 'superadmin' | 'event_creator' | 'tavf_creator' | 'user';
    isActive?: boolean;
  }) => {
    const query = new URLSearchParams();
    if (params?.page !== undefined) query.set('page', String(params.page));
    if (params?.pageSize !== undefined) query.set('pageSize', String(params.pageSize));
    if (params?.search) query.set('search', params.search);
    if (params?.role) query.set('role', params.role);
    if (params?.isActive !== undefined) query.set('isActive', String(params.isActive));
    const suffix = query.toString();
    return apiGet<AdminUsersResponse>(`/admin/users${suffix ? `?${suffix}` : ''}`);
  },
  deleteAdminUser: (userId: string) =>
    apiDelete<{ message: string; user_id: string }>(`/admin/users/${userId}`),
  listAvailableAppRoles: () =>
    apiGet<{ roles: AppRoleAvailable[] }>('/admin/app-roles/available'),
  getUserRoleAssignments: (email: string) =>
    apiGet<UserRoleAssignmentsResponse>(`/admin/app-roles/users?email=${encodeURIComponent(email)}`),
  assignAppRole: (email: string, role: string) =>
    apiPost<UserRoleAssignment>('/admin/app-roles/assign', { email, role }),
  removeAppRole: (assignmentId: string) =>
    apiDelete<{ message: string }>(`/admin/app-roles/assignments/${assignmentId}`),
};

export { adminApi };
export type {
  InviteDraftRequest,
  InviteDraftResponse,
  ApplyInviteDraftRequest,
  ApplyInviteDraftResponse,
  RetentionPreviewRequest,
  RetentionPreviewResponse,
  IdentityStatus,
  BulkIdentityStatusResponse,
  IdentityStatusSummaryResponse,
  InviteIdentityResponse,
  BulkInviteIdentityResponse,
  SupportEmailRelayConfig,
  AdminUser,
  AdminUsersResponse,
  AppRoleAvailable,
  UserRoleAssignment,
  UserRoleAssignmentsResponse,
};
