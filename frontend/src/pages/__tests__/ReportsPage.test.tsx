import { describe, expect, it } from 'vitest';
import { formatReportRate, getEventReportRates } from '../ReportsPage';

describe('report rates', () => {
  it('formats fill from capacity and attendance from assigned members', () => {
    expect(getEventReportRates({
      event_id: 'event-1',
      title: 'Clinic',
      event_date: '2026-09-14T15:00:00.000Z',
      location: 'Colorado Springs',
      status: 'completed',
      capacity: 20,
      yes_count: 10,
      no_count: 4,
      maybe_count: 2,
      waitlist_count: 1,
      assigned_count: 4,
      attended_count: 3,
    })).toEqual({ fillRate: '50%', attendRate: '75%' });
    expect(formatReportRate(0, 0)).toBe('—');
  });
});