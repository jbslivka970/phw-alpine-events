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

interface DeliverySummaryRow {
  channel: 'email' | 'sms';
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'stubbed' | 'skipped';
  operation_type: string | null;
  count: number;
}

interface DeliverySummaryResponse {
  from: string;
  to: string;
  total_notifications: number;
  rows: DeliverySummaryRow[];
}

interface DeliveryTrendRow {
  day: string;
  total_count: number;
  failed_count: number;
  successful_count: number;
  email_count: number;
  sms_count: number;
}

interface DeliveryTrendResponse {
  from: string;
  to: string;
  rows: DeliveryTrendRow[];
}

interface DeliveryLogRow {
  log_id: string;
  sent_at: string;
  event_id: string | null;
  member_id: string | null;
  template_id: string | null;
  channel: 'email' | 'sms';
  recipient: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'stubbed' | 'skipped';
  operation_type: string | null;
  operation_reason: string | null;
  provider_id: string | null;
  error_detail: string | null;
  provider_status: string | null;
  provider_error_detail: string | null;
  provider_checked_at: string | null;
  provider_source: string | null;
}

interface DeliveryLogResponse {
  from: string;
  to: string;
  page: number;
  page_size: number;
  total_rows: number;
  include_provider_status: boolean;
  rows: DeliveryLogRow[];
}

interface DeliveryFilters {
  channel?: 'email' | 'sms';
  status?: 'queued' | 'sent' | 'delivered' | 'failed' | 'stubbed' | 'skipped';
  operation_type?: string;
}

interface DeliveryLogFilters extends DeliveryFilters {
  event_id?: string;
  page?: number;
  page_size?: number;
  include_provider_status?: boolean;
}

function buildDeliveryQuery(from: string, to: string, filters?: DeliveryFilters): string {
  const params = new URLSearchParams({ from, to });
  if (filters?.channel) {
    params.set('channel', filters.channel);
  }
  if (filters?.status) {
    params.set('status', filters.status);
  }
  if (filters?.operation_type) {
    params.set('operation_type', filters.operation_type);
  }
  return params.toString();
}

function buildDeliveryLogQuery(from: string, to: string, filters?: DeliveryLogFilters): string {
  const params = new URLSearchParams({ from, to });
  if (filters?.channel) {
    params.set('channel', filters.channel);
  }
  if (filters?.status) {
    params.set('status', filters.status);
  }
  if (filters?.operation_type) {
    params.set('operation_type', filters.operation_type);
  }
  if (filters?.event_id) {
    params.set('event_id', filters.event_id);
  }
  if (typeof filters?.page === 'number' && Number.isFinite(filters.page) && filters.page > 0) {
    params.set('page', String(Math.floor(filters.page)));
  }
  if (typeof filters?.page_size === 'number' && Number.isFinite(filters.page_size) && filters.page_size > 0) {
    params.set('page_size', String(Math.floor(filters.page_size)));
  }
  if (filters?.include_provider_status) {
    params.set('include_provider_status', 'true');
  }
  return params.toString();
}

const reportsApi = {
  summary: (from: string, to: string) =>
    apiGet<ReportSummaryResponse>(`/reports/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  participation: (year?: number) =>
    apiGet<ParticipationResponse>(year ? `/reports/participation?year=${year}` : '/reports/participation'),
  delivery: (from: string, to: string, filters?: DeliveryFilters) =>
    apiGet<DeliverySummaryResponse>(`/reports/delivery?${buildDeliveryQuery(from, to, filters)}`),
  deliveryTrends: (from: string, to: string, filters?: DeliveryFilters) =>
    apiGet<DeliveryTrendResponse>(`/reports/delivery/trends?${buildDeliveryQuery(from, to, filters)}`),
  deliveryLogs: (from: string, to: string, filters?: DeliveryLogFilters) =>
    apiGet<DeliveryLogResponse>(`/reports/delivery/logs?${buildDeliveryLogQuery(from, to, filters)}`),
  downloadExport: async (from: string, to: string): Promise<void> => {
    const response = await apiGetBlob(`/reports/export?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match?.[1] ?? `project-healing-waters-events-${from}-to-${to}.csv`;

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
export type {
  EventSummaryRow,
  ParticipationResponse,
  ParticipationRow,
  ReportSummaryResponse,
  DeliverySummaryResponse,
  DeliverySummaryRow,
  DeliveryTrendResponse,
  DeliveryTrendRow,
  DeliveryFilters,
  DeliveryLogRow,
  DeliveryLogResponse,
  DeliveryLogFilters,
};