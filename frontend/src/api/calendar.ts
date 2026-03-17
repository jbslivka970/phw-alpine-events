import { apiGet } from './client';

interface CalendarEvent {
  event_id: string;
  title: string;
  event_date: string;
  location: string | null;
  status: 'draft' | 'published' | 'cancelled' | 'completed';
  capacity: number | null;
  yes_count: number;
  maybe_count: number;
  waitlist_count: number;
  targeted_groups: string[];
}

interface CalendarMonthResponse {
  month: string;
  range_start: string;
  range_end: string;
  events: CalendarEvent[];
}

const calendarApi = {
  getMonth: (month: string) => apiGet<CalendarMonthResponse>(`/calendar?month=${encodeURIComponent(month)}`),
};

export { calendarApi };
export type { CalendarEvent, CalendarMonthResponse };
