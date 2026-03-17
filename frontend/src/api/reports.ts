import { apiGet } from './client';

export interface DashboardStats {
  totalMembers: number;
  totalGroups: number;
  upcomingEvents: number;
  pendingRsvps: number;
}

export const reportsApi = {
  dashboard: () => apiGet<DashboardStats>('/v1/reports/dashboard'),
  membershipSummary: () => apiGet<unknown>('/v1/reports/membership'),
  eventAttendance: (eventId: number) =>
    apiGet<unknown>(`/v1/reports/events/${eventId}/attendance`),
};
