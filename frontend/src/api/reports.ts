import { apiGet } from './client';

interface DashboardStats {
  totalMembers: number;
  totalGroups: number;
  upcomingEvents: number;
  pendingRsvps: number;
}

const reportsApi = {
  dashboard: () => apiGet<{ data: DashboardStats | null; message?: string }>('/admin/users'),
};

export { reportsApi };
export type { DashboardStats };