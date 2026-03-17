import { apiDelete, apiGet, apiPost, apiPut } from './client';

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

export { eventsApi, rsvpApi };
export type { EventRecord, RsvpRecord };