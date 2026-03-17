import { apiGet, apiGetBlob } from './client';

interface EventSummaryRow {
  event_id: string;
  title: string;
  event_date: string;
  location: string | null;
  status: 'draft' | 'published' | 'cancelled' | 'completed';
  capacity: number | null;
  yes_count: number;
  no_count: number;
  maybe_count: number;
  waitlist_count: number;
  attended_count: number;
}

interface ReportSummaryResponse {
  from: string;
  to: string;
  total_events: number;
  total_rsvps: number;
  total_attended: number;
  avg_fill_rate: number;
  events: EventSummaryRow[];
}

interface ParticipationRow {
  member_id: string;
  first_name: string;
  last_name: string;
  events_attended: number;
  events_attended_prior_year: number;
}

interface ParticipationResponse {
  year: number;
  rows: ParticipationRow[];
}

const reportsApi = {
  summary: (from: string, to: string) =>
    apiGet<ReportSummaryResponse>(`/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  participation: (year?: number) =>
    apiGet<ParticipationResponse>(year ? `/reports/participation?year=${year}` : '/reports/participation'),
  downloadExport: async (from: string, to: string): Promise<void> => {
    const response = await apiGetBlob(`/reports/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match?.[1] ?? `phw-events-${from}-to-${to}.csv`;

    const url = URL.createObjectURL(response.blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  },
};

export { reportsApi };
export type { EventSummaryRow, ParticipationResponse, ParticipationRow, ReportSummaryResponse };