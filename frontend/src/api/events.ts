import { apiDelete, apiGet, apiPatch, apiPost, apiPut } from './client';

interface EventRecord {
  event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  event_date: string;
  end_date: string | null;
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

interface RsvpRecord {
  response_id: string;
  event_id: string;
  member_id: string;
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
  capacity: number | null;
  status: 'draft' | 'published' | 'completed' | 'cancelled';
  member_id: string;
  first_name: string | null;
  current_response: RsvpRecord['response'] | null;
  token_expires_at: string | null;
}

interface EventAssignmentRecord {
  assignment_id: string;
  member_id: string;
  first_name: string;
  last_name: string;
  role: 'MENTOR' | 'PARTICIPANT' | string;
  assigned_at: string;
  attended: boolean;
  attendance_notes?: string | null;
}

const eventsApi = {
  list: (status?: string) => apiGet<EventRecord[]>(status ? `/events?status=${encodeURIComponent(status)}` : '/events'),
  get: (id: string) => apiGet<EventRecord & { notification_targets: unknown[] }>(`/events/${id}`),
  create: (data: {
    title: string;
    event_date: string;
    description?: string | null;
    location?: string | null;
    end_date?: string | null;
    capacity?: number | null;
    notification_targets?: EventTarget[];
  }) => apiPost<EventRecord>('/events', data),
  update: (id: string, data: Partial<Omit<EventRecord, 'event_id' | 'created_at' | 'updated_at'>>) =>
    apiPut<EventRecord>(`/events/${id}`, data),
  updateStatus: (id: string, status: EventRecord['status']) =>
    apiPut<EventRecord>(`/events/${id}/status`, { status }),
  remove: (id: string) => apiDelete<void>(`/events/${id}`),
};

const rsvpApi = {
  list: (eventId: string, response?: string) =>
    apiGet<RsvpRecord[]>(response ? `/events/${eventId}/rsvp?response=${encodeURIComponent(response)}` : `/events/${eventId}/rsvp`),
  upsert: (eventId: string, payload: { member_id: string; response: RsvpRecord['response']; notes?: string | null }) =>
    apiPost<RsvpRecord>(`/events/${eventId}/rsvp`, payload),
  remove: (eventId: string, memberId: string) => apiDelete<void>(`/events/${eventId}/rsvp/${memberId}`),
};

const emailRsvpApi = {
  get: (token: string) => apiPost<PublicRsvpContext>('/sms/inbound', { token }),
  submit: (token: string, payload: { response: RsvpRecord['response'] }) =>
    apiPost<RsvpRecord>('/sms/inbound', { token, ...payload }),
};

const assignmentsApi = {
  list: (eventId: string) => apiGet<EventAssignmentRecord[]>(`/events/${eventId}/assignments`),
  create: (eventId: string, payload: { member_id: string; role: 'MENTOR' | 'PARTICIPANT' }) =>
    apiPost<EventAssignmentRecord>(`/events/${eventId}/assignments`, payload),
  remove: (eventId: string, assignmentId: string) =>
    apiDelete<void>(`/events/${eventId}/assignments/${assignmentId}`),
  setAttendance: (eventId: string, assignmentId: string, payload: { attended: boolean; attendance_notes?: string | null }) =>
    apiPatch<EventAssignmentRecord>(`/events/${eventId}/assignments/${assignmentId}/attendance`, payload),
};

export { assignmentsApi, emailRsvpApi, eventsApi, rsvpApi };
export type { EventRecord, RsvpRecord, EventAssignmentRecord, PublicRsvpContext };