import { apiGet } from './client';

export interface CalendarEvent {
  event_id: string;
  title: string;
  event_date: string; // ISO date string — column is "event_date" not "start_date"
  location: string | null;
  capacity: number | null;
  yes_count: number;
  maybe_count: number;
  waitlist_count: number;
  status: 'draft' | 'published' | 'cancelled' | 'completed';
  targeted_groups: string[];
}

export interface CalendarResponse {
  month: string;
  range_start: string;
  range_end: string;
  events: CalendarEvent[];
}

const calendarApi = {
  getMonth: (month: string) =>
    apiGet<CalendarResponse>(`/calendar?month=${encodeURIComponent(month)}`),
};

export { calendarApi };
