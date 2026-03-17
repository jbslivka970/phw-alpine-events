import { apiGet, BASE_URL } from './client';

export interface EventSummaryRow {
  event_id: string;
  title: string;
  event_date: string; // column is "event_date" not "start_date"
  location: string | null;
  status: 'draft' | 'published' | 'cancelled' | 'completed';
  capacity: number | null;
  yes_count: number;
  no_count: number;
  maybe_count: number;
  waitlist_count: number;
  attended_count: number;
  targeted_groups: string[];
}

export interface ReportSummary {
  from: string;
  to: string;
  total_events: number;
  total_rsvps: number;
  total_attended: number;
  avg_fill_rate: number;
  events: EventSummaryRow[];
}

export interface ParticipationRow {
  member_id: string;
  first_name: string;
  last_name: string;
  events_attended: number;
  events_attended_prior_year: number;
}

const reportsApi = {
  getSummary: (from: string, to: string) =>
    apiGet<ReportSummary>(`/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),

  getParticipation: (year?: number) =>
    apiGet<{ year: number; members: ParticipationRow[] }>(
      `/reports/participation${year ? `?year=${year}` : ''}`
    ),

  downloadExport: async (from: string, to: string): Promise<void> => {
    const url = `${BASE_URL}/reports/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) throw new Error(`Export failed: ${response.status}`);

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = `phw-events-${from}-to-${to}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(objectUrl);
  },
};

export { reportsApi };
