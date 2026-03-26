import { useEffect, useMemo, useState } from 'react';
import { calendarApi } from '../api/calendar';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  event_id: string;
  title: string;
  event_date: string;
  location: string | null;
  capacity: number | null;
  yes_count: number;
  maybe_count: number;
  waitlist_count: number;
  status: 'draft' | 'published' | 'cancelled' | 'completed';
  targeted_groups: string[];
}

type ViewMode = 'month' | 'list';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function isoToDate(iso: string): Date {
  return new Date(iso);
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

// Returns a CSS class string representing fill level
function capacityClass(event: CalendarEvent): string {
  if (event.capacity === null || event.capacity === 0) return 'cap-none';
  const ratio = totalRsvpCount(event) / event.capacity;
  if (ratio >= 1) return 'cap-full';
  if (ratio >= 0.75) return 'cap-high';
  if (ratio >= 0.4) return 'cap-medium';
  return 'cap-low';
}

function capacityLabel(event: CalendarEvent): string {
  if (event.capacity === null) return '';
  if (event.capacity === 0) return 'Unlimited';
  const remaining = event.capacity - totalRsvpCount(event);
  if (remaining <= 0) return 'FULL';
  return `${totalRsvpCount(event)}/${event.capacity}`;
}

function totalRsvpCount(event: CalendarEvent): number {
  return event.yes_count + event.maybe_count + event.waitlist_count;
}

function suggestedIcsFilename(event: CalendarEvent): string {
  const safeTitle = event.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safeTitle || 'event'}-${event.event_id}.ics`;
}

function parseDispositionFilename(headerValue: string | null): string | null {
  if (!headerValue) {
    return null;
  }

  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(headerValue);
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1]);
  }

  const plainMatch = /filename="?([^";]+)"?/i.exec(headerValue);
  return plainMatch?.[1] ?? null;
}

async function downloadEventIcs(event: CalendarEvent): Promise<void> {
  const { blob, headers } = await calendarApi.downloadIcs(event.event_id);
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const fromHeader = parseDispositionFilename(headers.get('content-disposition'));
  anchor.href = objectUrl;
  anchor.download = fromHeader ?? suggestedIcsFilename(event);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function CapacityBadge({ event }: { event: CalendarEvent }) {
  const label = capacityLabel(event);
  if (!label) return null;
  return <span className={`capacity-badge ${capacityClass(event)}`}>{label}</span>;
}

function EventChip({ event }: { event: CalendarEvent }) {
  return (
    <div
      className={`event-chip status-${event.status}`}
      title={`${event.title} — ${event.location}`}
    >
      <span className="event-chip-title">{event.title}</span>
      <CapacityBadge event={event} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Month View
// ---------------------------------------------------------------------------

function MonthView({
  year,
  month,
  events,
}: {
  year: number;
  month: number;
  events: CalendarEvent[];
}) {
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = new Date();

  // Build grid cells — leading empty cells + day cells
  const cells: Array<number | null> = [
    ...Array(firstDay).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  // Pad to complete last row
  while (cells.length % 7 !== 0) cells.push(null);

  return (
    <div className="month-view">
      <div className="month-grid-header">
        {DAY_LABELS.map((d) => (
          <div key={d} className="day-label">{d}</div>
        ))}
      </div>
      <div className="month-grid">
        {cells.map((day, idx) => {
          if (day === null) {
            return <div key={`empty-${idx}`} className="day-cell day-cell--empty" />;
          }
          const cellDate = new Date(year, month, day);
          const dayEvents = events.filter((e) => sameDay(isoToDate(e.event_date), cellDate));
          const isToday = sameDay(cellDate, today);
          return (
            <div key={day} className={`day-cell${isToday ? ' day-cell--today' : ''}`}>
              <span className="day-number">{day}</span>
              <div className="day-events">
                {dayEvents.map((e) => (
                  <EventChip key={e.event_id} event={e} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// List View
// ---------------------------------------------------------------------------

function ListItem({ event }: { event: CalendarEvent }) {
  const start = isoToDate(event.event_date);
  const dateStr = start.toLocaleDateString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric',
  });
  const timeStr = start.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

  return (
    <div className={`list-item status-${event.status}`}>
      <div className="list-item-date">
        <span className="list-date">{dateStr}</span>
        <span className="list-time">{timeStr}</span>
      </div>
      <div className="list-item-body">
        <span className="list-title">{event.title}</span>
        <span className="list-location">{event.location}</span>
        {event.targeted_groups.length > 0 && (
          <span className="list-groups">{event.targeted_groups.join(', ')}</span>
        )}
      </div>
      <div className="list-item-meta">
        <CapacityBadge event={event} />
        <span className={`status-pill status-pill--${event.status}`}>{event.status}</span>
        <button className="btn btn--outline btn--sm" onClick={() => void downloadEventIcs(event)}>
          ICS
        </button>
      </div>
    </div>
  );
}

function ListView({ events }: { events: CalendarEvent[] }) {
  const sorted = [...events].sort(
    (a, b) => new Date(a.event_date).getTime() - new Date(b.event_date).getTime(),
  );

  if (sorted.length === 0) {
    return <p className="empty-state">No events found for this period.</p>;
  }

  return (
    <div className="list-view">
      {sorted.map((e) => (
        <ListItem key={e.event_id} event={e} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CalendarPage
// ---------------------------------------------------------------------------

function CalendarPage() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [view, setView] = useState<ViewMode>('month');
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const monthKey = useMemo(() => `${year}-${String(month + 1).padStart(2, '0')}`, [year, month]);

  useEffect(() => {
    let isMounted = true;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await calendarApi.getMonth(monthKey);
        if (isMounted) {
          setEvents(response.events);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to load calendar events.');
          setEvents([]);
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    void load();
    return () => {
      isMounted = false;
    };
  }, [monthKey]);

  function prevMonth() {
    if (month === 0) { setMonth(11); setYear((y) => y - 1); }
    else setMonth((m) => m - 1);
  }

  function nextMonth() {
    if (month === 11) { setMonth(0); setYear((y) => y + 1); }
    else setMonth((m) => m + 1);
  }

  return (
    <div className="page calendar-page">
      <div className="page-header">
        <h1>Calendar</h1>
        <div className="header-actions">
          <div className="view-toggle">
            <button
              className={view === 'month' ? 'active' : ''}
              onClick={() => setView('month')}
            >
              Month
            </button>
            <button
              className={view === 'list' ? 'active' : ''}
              onClick={() => setView('list')}
            >
              List
            </button>
          </div>
        </div>
      </div>

      <div className="calendar-nav">
        <button onClick={prevMonth}>&lsaquo;</button>
        <h2>{MONTH_NAMES[month]} {year}</h2>
        <button onClick={nextMonth}>&rsaquo;</button>
      </div>

      <div className="capacity-legend">
        <span className="legend-item cap-low">Low fill</span>
        <span className="legend-item cap-medium">Medium fill</span>
        <span className="legend-item cap-high">High fill (&ge;75%)</span>
        <span className="legend-item cap-full">Full</span>
        <span className="legend-item cap-none">No cap</span>
      </div>

      {loading && <p>Loading calendar events...</p>}
      {error && <p className="empty-state">{error}</p>}

      {view === 'month' ? (
        <MonthView year={year} month={month} events={events} />
      ) : (
        <ListView events={events} />
      )}
    </div>
  );
}

export { CalendarPage }
