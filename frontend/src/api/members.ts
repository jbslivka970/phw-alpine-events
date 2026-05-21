import { apiDelete, apiGet, apiPatch, apiPost } from './client';

interface MemberRecord {
  member_id: string;
  first_name: string;
  last_name: string;
  email: string;
  mobile_phone: string | null;
  sms_opt_in: boolean;
  sms_opt_in_date?: string | null;
  sms_opt_out_date?: string | null;
  email_opt_out: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  auth_roles?: Array<'ADMIN' | 'EVENT_CREATOR' | 'USER' | 'TAVF_CREATOR'>;
  personas?: string | null;
}

interface ListMembersResponse {
  data: MemberRecord[];
  total: number;
  page: number;
  pageSize: number;
}

interface SmsConsentLogRow {
  consent_log_id: string;
  member_id: string;
  action: 'opt_in' | 'opt_out';
  source: 'import' | 'manual' | 'reply' | 'api' | 'system';
  recorded_at: string;
  notes: string | null;
}

interface MemberParticipation {
  member_id: string;
  year: number;
  events_attended: number;
  events_attended_prior_year: number;
  mentor_attended: number;
  mentor_attended_prior_year: number;
  participant_attended: number;
  participant_attended_prior_year: number;
}

interface SmsRolloutStatusResponse {
  member_id: string;
  sms_rollout_enabled: boolean;
  reason: 'open_rollout' | 'email_allowlist' | 'group_allowlist' | 'not_in_rollout_cohort' | 'missing_member_email';
  configured_emails: string[];
  configured_groups: string[];
  matched_groups: string[];
}

const membersApi = {
  list: (params?: { page?: number; pageSize?: number; search?: string; isActive?: boolean }) => {
    const query = new URLSearchParams();
    if (params?.page) query.set('page', String(params.page));
    if (params?.pageSize) query.set('pageSize', String(params.pageSize));
    if (params?.search) query.set('search', params.search);
    if (params?.isActive !== undefined) query.set('isActive', String(params.isActive));
    const suffix = query.toString();
    return apiGet<ListMembersResponse>(suffix ? `/members?${suffix}` : '/members');
  },
  me: () => apiGet<MemberRecord>('/members/me'),
  get: (id: string) => apiGet<MemberRecord>(`/members/${id}`),
  groups: (id: string) => apiGet<unknown[]>(`/members/${id}/groups`),
  create: (data: Partial<MemberRecord>) => apiPost<MemberRecord>('/members', data),
  update: (id: string, data: Partial<MemberRecord>) => apiPatch<MemberRecord>(`/members/${id}`, data),
  updateSmsConsent: (id: string, sms_opt_in: boolean) =>
    apiPatch<MemberRecord>(`/members/${id}/sms-consent`, { sms_opt_in }),
  updateChannelPreference: (id: string, channel_preference: 'email_only' | 'sms_only' | 'both') =>
    apiPatch<MemberRecord>(`/members/${id}/channel-preference`, { channel_preference }),
  updateMyPhone: (mobile_phone: string | null) =>
    apiPatch<MemberRecord>('/members/me/phone', { mobile_phone }),
  smsRolloutStatus: (id: string) => apiGet<SmsRolloutStatusResponse>(`/members/${id}/sms-rollout-status`),
  consentLog: (id: string) => apiGet<SmsConsentLogRow[]>(`/members/${id}/sms-consent-log`),
  participation: (id: string) => apiGet<MemberParticipation>(`/members/${id}/participation`),
  rsvps: (id: string) => apiGet<Array<{
    response_id: string;
    response: 'yes' | 'no' | 'maybe' | 'waitlist';
    responded_at: string;
    event_id: string;
    title: string;
    event_date: string;
    location: string | null;
    status: string;
  }>>(`/members/${id}/rsvps`),
  myRsvps: (limit?: number) => {
    const query = new URLSearchParams();
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) {
      query.set('limit', String(Math.floor(limit)));
    }
    const suffix = query.toString();
    return apiGet<Array<{
      response_id: string;
      response: 'yes' | 'no' | 'maybe' | 'waitlist';
      responded_at: string;
      event_id: string;
      title: string;
      event_date: string;
      location: string | null;
      status: string;
    }>>(suffix ? `/members/me/rsvps?${suffix}` : '/members/me/rsvps');
  },
  remove: (id: string) => apiDelete<{ message: string; member: MemberRecord }>(`/members/${id}`),
  hardDelete: (id: string) => apiDelete<{ message: string; member: MemberRecord }>(`/members/${id}/purge`),
};

export { membersApi };
export type { MemberRecord, ListMembersResponse, SmsConsentLogRow, MemberParticipation, SmsRolloutStatusResponse };