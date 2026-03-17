import { apiGet, apiPost, apiPut, apiDelete } from './client';

export interface Event {
  id: number;
  title: string;
  description?: string;
  location?: string;
  startDate: string;
  endDate?: string;
  maxAttendees?: number;
  status: string;
  createdAt?: string;
}

export interface Rsvp {
  memberId: number;
  eventId: number;
  status: 'attending' | 'waitlisted' | 'declined';
}

export const eventsApi = {
  list: () => apiGet<Event[]>('/v1/events'),
  get: (id: number) => apiGet<Event>(`/v1/events/${id}`),
  create: (data: Omit<Event, 'id' | 'createdAt'>) => apiPost<Event>('/v1/events', data),
  update: (id: number, data: Partial<Event>) => apiPut<Event>(`/v1/events/${id}`, data),
  remove: (id: number) => apiDelete<void>(`/v1/events/${id}`),
};

export const rsvpApi = {
  upsert: (data: Rsvp) => apiPost<Rsvp>('/v1/rsvp', data),
};
