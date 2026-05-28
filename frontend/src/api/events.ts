import { apiDelete, apiGet, apiGetBlob, apiPatch, apiPost, apiPut } from './client';

interface EventRecord {
  event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  photo_url: string | null;
  invitation_stage: 'volunteer' | 'participant' | 'both';
  event_lead_member_id: string | null;
  event_lead_secondary_roles?: Array<'MENTOR' | 'PARTICIPANT'>;
  event_lead_name: string | null;
  event_lead_email: string | null;
  scheduler_email?: string | null;
  event_date: string;
  end_date: string | null;
  mentor_capacity: number | null;
  participant_capacity: number | null;
  capacity: number | null;
  status: 'draft' | 'published' | 'completed' | 'cancelled';
  created_by: string | null;
  created_at: string;
  updated_at: string;
  yes_count?: number;
  target_count?: number;
}

interface EventTarget {
  group_id?: string;
}

interface UpdateEventPayload {
  title?: string;
  description?: string | null;
  location?: string | null;
  photo_url?: string | null;
  invitation_stage?: 'volunteer' | 'participant' | 'both';
  event_lead_member_id?: string | null;
  event_lead_secondary_roles?: Array<'MENTOR' | 'PARTICIPANT'>;
  scheduler_email?: string | null;
  event_date?: string;
  end_date?: string | null;
  mentor_capacity?: number | null;
  participant_capacity?: number | null;
  capacity?: number | null;
  update_reason?: string | null;
}

interface EventAiDraftResponse {
  event_id: string | null;
  tone: 'friendly' | 'professional' | 'casual' | 'exciting';
  subject: string;
  emailBody: string;
  smsBody: string;
  provider: 'azure-openai' | 'openai' | 'fallback';
  mapUrl?: string | null;
  imageSuggestions?: string[];
}

interface EventAiDescriptionResponse {
  tone: 'friendly' | 'professional' | 'casual' | 'exciting';
  polished_description: string;
  provider: 'azure-openai' | 'openai' | 'fallback';
}

interface RsvpRecord {
  response_id: string;
  event_id: string;
  member_id: string;
  response_role?: 'MENTOR' | 'PARTICIPANT';
  response: 'yes' | 'no' | 'maybe' | 'waitlist';
  responded_at: string;
  notes: string | null;
  first_name?: string;
  last_name?: string;
  email?: string;
  mobile_phone?: string;
}

interface PublicRsvpContext {
  event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  event_date: string;
  end_date: string | null;
  mentor_capacity: number | null;
  participant_capacity: number | null;
  capacity: number | null;
  status: 'draft' | 'published' | 'completed' | 'cancelled';
  event_lead_member_id: string | null;
  is_event_lead_member?: boolean;
  member_id: string;
  first_name: string | null;
  current_response: RsvpRecord['response'] | null;
  current_response_role?: 'MENTOR' | 'PARTICIPANT' | null;
  inferred_response_role?: 'MENTOR' | 'PARTICIPANT' | null;
  token_expires_at: string | null;
}

interface EventAssignmentRecord {
  assignment_id: string;
  member_id: string;
  first_name: string;
  last_name: string;
  role: 'LEAD' | 'MENTOR' | 'PARTICIPANT' | string;
  assigned_at: string;
  attended: boolean;
  attendance_notes?: string | null;
}

interface EventGuestAssignmentRecord {
  guest_assignment_id: string;
  event_id: string;
  role: 'MENTOR' | 'PARTICIPANT';
  guest_name: string;
  guest_email: string;
  guest_phone: string | null;
  guest_program_group_id: string | null;
  guest_program_id?: string | null;
  guest_program_name: string;
  guest_program_group_name?: string | null;
  guest_program_catalog_name?: string | null;
  guest_program_state_name?: string | null;
  invited_at: string;
}

interface CreateGuestAssignmentPayload {
  role: 'MENTOR' | 'PARTICIPANT';
  guest_name: string;
  guest_email: string;
  guest_phone?: string | null;
  program_group_id?: string | null;
  program_id?: string | null;
  program_name?: string | null;
}

interface AssignmentRecommendationRow {
  rank: number;
  member_id: string;
  first_name: string;
  last_name: string;
  response: 'yes' | 'no' | 'maybe' | 'waitlist';
  suggested_role: 'MENTOR' | 'PARTICIPANT';
  equity_score: number;
  role_attended_year: number;
  role_attended_prior_year: number;
  total_attended_year: number;
  total_attended_prior_year: number;
  reason: string;
}

interface AssignmentRecommendationResponse {
  event_id: string;
  role: 'MENTOR' | 'PARTICIPANT';
  rows: AssignmentRecommendationRow[];
}

interface CloseAtCapacityResponse {
  event: {
    event_id: string;
    mentor_capacity: number | null;
    participant_capacity: number | null;
    capacity: number | null;
    status: 'draft' | 'published' | 'completed' | 'cancelled';
  };
  snapshot: {
    assigned_mentor_count: number;
    assigned_participant_count: number;
    yes_mentor_count: number;
    yes_participant_count: number;
  };
  message: string;
}

type EventListOptions = RequestInit & {
  upcoming?: boolean;
  limit?: number;
  sort?: 'asc' | 'desc';
};

interface DashboardSummaryResponse {
  totalEventsThisYear: number;
  upcomingEvents: number;
  totalRsvps: number;
}

const eventsApi = {
  list: (status?: string, options?: EventListOptions) => {
    const query = new URLSearchParams();
    if (status) {
      query.set('status', status);
    }
    if (options?.upcoming !== undefined) {
      query.set('upcoming', String(options.upcoming));
    }
    if (typeof options?.limit === 'number' && Number.isFinite(options.limit) && options.limit > 0) {
      query.set('limit', String(Math.floor(options.limit)));
    }
    if (options?.sort) {
      query.set('sort', options.sort);
    }

    const requestOptions = options ? { ...options } : undefined;
    if (requestOptions) {
      delete (requestOptions as EventListOptions).upcoming;
      delete (requestOptions as EventListOptions).limit;
      delete (requestOptions as EventListOptions).sort;
    }
    const suffix = query.toString();
    return apiGet<EventRecord[]>(suffix ? `/events?${suffix}` : '/events', requestOptions);
  },
  dashboardSummary: (options?: RequestInit) =>
    apiGet<DashboardSummaryResponse>('/events/dashboard-summary', options),
  get: (id: string) => apiGet<EventRecord & { notification_targets: unknown[] }>(`/events/${id}`),
  create: (data: {
    title: string;
    event_date: string;
    description?: string | null;
    location?: string | null;
    photo_url?: string | null;
    invitation_stage?: 'volunteer' | 'participant' | 'both';
    event_lead_member_id?: string | null;
    event_lead_secondary_roles?: Array<'MENTOR' | 'PARTICIPANT'>;
    scheduler_email?: string | null;
    end_date?: string | null;
    mentor_capacity?: number | null;
    participant_capacity?: number | null;
    capacity?: number | null;
    notification_targets?: EventTarget[];
  }) => apiPost<EventRecord>('/events', data),
  update: (id: string, data: UpdateEventPayload) =>
    apiPut<EventRecord>(`/events/${id}`, data),
  updateStatus: (id: string, status: EventRecord['status']) =>
    apiPut<EventRecord>(`/events/${id}/status`, { status }),
  sendReminder: (id: string) =>
    apiPost<{ ok: boolean; event_id: string; sent: boolean }>(`/events/${id}/send-reminder`, {}),
  sendUpdate: (id: string, payload: { update_reason: string; change_summary?: string | null; changed_fields?: string[] }) =>
    apiPost<{ ok: boolean; event_id: string; sent: boolean }>(`/events/${id}/send-update`, payload),
  downloadIcs: (id: string) => apiGetBlob(`/events/${id}/ics`),
  downloadReportCsv: (id: string) => apiGetBlob(`/events/${id}/report.csv`),
  downloadReportPdf: (id: string) => apiGetBlob(`/events/${id}/report.pdf`),
  downloadReportText: (id: string) => apiGetBlob(`/events/${id}/report.txt`),
  emailReport: (id: string, recipients?: string[]) =>
    apiPost<{ event_id: string; to: string; cc: string[]; sent: number }>(
      `/events/${id}/report/email`,
      recipients && recipients.length > 0 ? { recipients } : {}
    ),
  sendLeadPrepSummary: (id: string) => apiPost<{ event_id: string; to: string; cc: string[]; sent: number }>(`/events/${id}/lead-summary/email`, {}),
  sendParticipationSummary: (id: string) => apiPost<{ event_id: string; to: string; cc: string[]; fallback_used: 'scheduler'; sent: number }>(`/events/${id}/participation-summary/email`, {}),
  generateAiDraft: (id: string, tone: 'friendly' | 'professional' | 'casual' | 'exciting' = 'friendly') =>
    apiPost<EventAiDraftResponse>(`/events/${id}/ai-draft`, { tone }),
  generateAiDraftPreview: (
    payload: {
      title: string;
      event_date: string;
      location?: string | null;
      description?: string | null;
      event_lead_name?: string | null;
    },
    tone: 'friendly' | 'professional' | 'casual' | 'exciting' = 'friendly'
  ) => apiPost<EventAiDraftResponse>('/events/ai-draft-preview', { ...payload, tone }),
  generateAiDescriptionPreview: (
    payload: {
      title: string;
      description: string;
      event_date?: string;
      location?: string | null;
      event_lead_name?: string | null;
    },
    tone: 'friendly' | 'professional' | 'casual' | 'exciting' = 'friendly'
  ) => apiPost<EventAiDescriptionResponse>('/events/ai-description-preview', { ...payload, tone }),
  remove: (id: string) => apiDelete<void>(`/events/${id}`),
};

const rsvpApi = {
  list: (eventId: string, response?: string) =>
    apiGet<RsvpRecord[]>(response ? `/events/${eventId}/rsvp?response=${encodeURIComponent(response)}` : `/events/${eventId}/rsvp`),
  upsert: (eventId: string, payload: { member_id?: string; response: RsvpRecord['response']; response_role?: 'MENTOR' | 'PARTICIPANT'; notes?: string | null }) =>
    apiPost<RsvpRecord>(`/events/${eventId}/rsvp`, payload),
  remove: (eventId: string, memberId: string) => apiDelete<void>(`/events/${eventId}/rsvp/${memberId}`),
};

const emailRsvpApi = {
  get: (token: string) => apiGet<PublicRsvpContext>(`/events/rsvp/${encodeURIComponent(token)}`),
  resolveShort: (code: string) => apiGet<{ token: string }>(`/events/rsvp/short/${encodeURIComponent(code)}`),
  submit: (token: string, payload: { response: RsvpRecord['response']; response_role?: 'MENTOR' | 'PARTICIPANT' }) =>
    apiPost<RsvpRecord>(`/events/rsvp/${encodeURIComponent(token)}`, payload),
};

const assignmentsApi = {
  list: (eventId: string) => apiGet<EventAssignmentRecord[]>(`/events/${eventId}/assignments`),
  guestList: (eventId: string) => apiGet<EventGuestAssignmentRecord[]>(`/events/${eventId}/guest-assignments`),
  create: (eventId: string, payload: { member_id: string; role: 'MENTOR' | 'PARTICIPANT' }) =>
    apiPost<EventAssignmentRecord>(`/events/${eventId}/assignments`, payload),
  createGuest: (eventId: string, payload: CreateGuestAssignmentPayload) =>
    apiPost<EventGuestAssignmentRecord>(`/events/${eventId}/guest-assignments`, payload),
  remove: (eventId: string, assignmentId: string) =>
    apiDelete<void>(`/events/${eventId}/assignments/${assignmentId}`),
  removeGuest: (eventId: string, guestAssignmentId: string) =>
    apiDelete<void>(`/events/${eventId}/guest-assignments/${guestAssignmentId}`),
  setAttendance: (eventId: string, assignmentId: string, payload: { attended: boolean; attendance_notes?: string | null }) =>
    apiPatch<EventAssignmentRecord>(`/events/${eventId}/assignments/${assignmentId}/attendance`, payload),
  recommendations: (eventId: string, role: 'MENTOR' | 'PARTICIPANT', limit = 20) =>
    apiGet<AssignmentRecommendationResponse>(`/events/${eventId}/assignment-recommendations?role=${role}&limit=${limit}`),
  closeAtCapacity: (eventId: string) =>
    apiPost<CloseAtCapacityResponse>(`/events/${eventId}/close-at-capacity`, {}),
};

export { assignmentsApi, emailRsvpApi, eventsApi, rsvpApi };
export type {
  EventRecord,
  RsvpRecord,
  EventAssignmentRecord,
  EventGuestAssignmentRecord,
  CreateGuestAssignmentPayload,
  AssignmentRecommendationResponse,
  AssignmentRecommendationRow,
  CloseAtCapacityResponse,
  PublicRsvpContext,
  UpdateEventPayload,
  EventAiDraftResponse,
  EventAiDescriptionResponse,
};