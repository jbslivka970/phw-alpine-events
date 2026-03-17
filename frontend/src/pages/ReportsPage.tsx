import { useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventSummaryRow {
  event_id: string;
  title: string;
  start_date: string;
  location: string;
  status: 'draft' | 'published' | 'cancelled' | 'completed';
  capacity: number | null;
  rsvp_count: number;
  attended_count: number;
  targeted_groups: string[];
}

export interface ReportSummary {
  total_events: number;
  total_rsvps: number;
  total_attended: number;
  avg_fill_rate: number; // 0–1
  events: EventSummaryRow[];
}

type ExportFormat = 'csv' | 'pdf';

// ---------------------------------------------------------------------------
// Placeholder data hook
// ---------------------------------------------------------------------------

function usePlaceholderSummary(fromDate: string, toDate: string): ReportSummary {
  // TODO: replace with real API call — GET /api/reports/summary?from=&to=
  void fromDate; void toDate;
  return {
    total_events: 3,
    total_rsvps: 52,
    total_attended: 44,
    avg_fill_rate: 0.71,
    events: [
      {
        event_id: 'r1',
        title: 'Spring Hike',
        start_date: new Date().toISOString(),
        location: 'Trailhead A',
        status: 'completed',
        capacity: 20,
        rsvp_count: 18,
        attended_count: 15,
        targeted_groups: ['All Members'],
      },
      {
        event_id: 'r2',
        title: 'Board Meeting',
        start_date: new Date(Date.now() - 7 * 86400000).toISOString(),
        location: 'Community Center',
        status: 'completed',
        capacity: 30,
        rsvp_count: 24,
        attended_count: 22,
        targeted_groups: ['Board'],
      },
      {
        event_id: 'r3',
        title: 'Skill Workshop',
        start_date: new Date(Date.now() + 7 * 86400000).toISOString(),
        location: 'Mountain Base',
        status: 'published',
        capacity: null,
        rsvp_count: 10,
        attended_count: 7,
        targeted_groups: ['Beginners'],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Export stub
// ---------------------------------------------------------------------------

function triggerExport(format: ExportFormat, from: string, to: string) {
  // TODO: call GET /api/reports/export?format=<format>&from=<from>&to=<to>
  //       then download the returned file blob.
  console.log('[Reports] export requested', { format, from, to });
  alert(`Export as ${format.toUpperCase()} — feature coming soon.\nRange: ${from} → ${to}`);
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat-card">
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Summary grid row
// ---------------------------------------------------------------------------

function SummaryRow({ row }: { row: EventSummaryRow }) {
  const startDate = new Date(row.start_date).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const fillRate =
    row.capacity && row.capacity > 0
      ? `${Math.round((row.rsvp_count / row.capacity) * 100)}%`
      : '—';
  const attendRate =
    row.rsvp_count > 0
      ? `${Math.round((row.attended_count / row.rsvp_count) * 100)}%`
      : '—';

  return (
    <tr className={`summary-row status-row--${row.status}`}>
      <td>{row.title}</td>
      <td>{startDate}</td>
      <td>{row.location}</td>
      <td>
        <span className={`status-pill status-pill--${row.status}`}>{row.status}</span>
      </td>
      <td>{row.capacity ?? '∞'}</td>
      <td>{row.rsvp_count}</td>
      <td>{row.attended_count}</td>
      <td>{fillRate}</td>
      <td>{attendRate}</td>
      <td>{row.targeted_groups.join(', ')}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Export button group (reusable)
// ---------------------------------------------------------------------------

function ExportButtons({ fromDate, toDate }: { fromDate: string; toDate: string }) {
  return (
    <div className="export-actions">
      <button
        className="btn btn-primary"
        onClick={() => triggerExport('csv', fromDate, toDate)}
      >
        Download CSV
      </button>
      <button
        className="btn btn-secondary"
        onClick={() => triggerExport('pdf', fromDate, toDate)}
      >
        Download PDF
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ReportsPage
// ---------------------------------------------------------------------------

function ReportsPage() {
  const today = new Date();
  const firstOfMonth = new Date(today.getFullYear(), today.getMonth(), 1)
    .toISOString().slice(0, 10);
  const todayIso = today.toISOString().slice(0, 10);

  const [fromDate, setFromDate] = useState(firstOfMonth);
  const [toDate, setToDate] = useState(todayIso);

  const summary = usePlaceholderSummary(fromDate, toDate);

  const fillRatePct = `${Math.round(summary.avg_fill_rate * 100)}%`;
  const attendRate =
    summary.total_rsvps > 0
      ? `${Math.round((summary.total_attended / summary.total_rsvps) * 100)}%`
      : '—';

  return (
    <div className="page reports-page">
      <div className="page-header">
        <h1>Reports</h1>
      </div>

      {/* Date range filter */}
      <div className="report-filters">
        <label>
          From
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </label>
      </div>

      {/* Top-level stat cards */}
      <div className="stat-grid">
        <StatCard label="Total Events" value={summary.total_events} />
        <StatCard label="Total RSVPs" value={summary.total_rsvps} />
        <StatCard label="Attended" value={summary.total_attended} />
        <StatCard label="Avg Fill Rate" value={fillRatePct} />
        <StatCard label="Attendance Rate" value={attendRate} />
      </div>

      {/* Event summary grid */}
      <div className="summary-table-wrapper">
        <h2>Event Breakdown</h2>
        <table className="summary-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Date</th>
              <th>Location</th>
              <th>Status</th>
              <th>Capacity</th>
              <th>RSVPs</th>
              <th>Attended</th>
              <th>Fill %</th>
              <th>Attend %</th>
              <th>Groups</th>
            </tr>
          </thead>
          <tbody>
            {summary.events.length === 0 ? (
              <tr>
                <td colSpan={10} className="empty-state">No events in this range.</td>
              </tr>
            ) : (
              summary.events.map((row) => <SummaryRow key={row.event_id} row={row} />)
            )}
          </tbody>
        </table>
      </div>

      {/* Export section */}
      <div className="export-section">
        <h2>Export</h2>
        <p className="export-desc">
          Download event and RSVP data for the selected date range.
        </p>
        <ExportButtons fromDate={fromDate} toDate={toDate} />
      </div>
    </div>
  );
}

export { ReportsPage }
