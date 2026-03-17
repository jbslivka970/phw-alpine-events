import { useState, useEffect, useCallback } from 'react';
import { reportsApi, ReportSummary, EventSummaryRow } from '../api/reports';

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
  const eventDate = new Date(row.event_date).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const fillRate =
    row.capacity && row.capacity > 0
      ? `${Math.round((row.yes_count / row.capacity) * 100)}%`
      : '—';
  const attendRate =
    row.yes_count > 0
      ? `${Math.round((row.attended_count / row.yes_count) * 100)}%`
      : '—';

  return (
    <tr className={`summary-row status-row--${row.status}`}>
      <td>{row.title}</td>
      <td>{eventDate}</td>
      <td>{row.location ?? '—'}</td>
      <td>
        <span className={`status-pill status-pill--${row.status}`}>{row.status}</span>
      </td>
      <td>{row.capacity ?? '∞'}</td>
      <td>{row.yes_count}</td>
      <td>{row.no_count}</td>
      <td>{row.maybe_count}</td>
      <td>{row.waitlist_count}</td>
      <td>{row.attended_count}</td>
      <td>{fillRate}</td>
      <td>{attendRate}</td>
      <td>{row.targeted_groups.join(', ')}</td>
    </tr>
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
  const [summary, setSummary] = useState<ReportSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const fetchSummary = useCallback(async (from: string, to: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await reportsApi.getSummary(from, to);
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load report');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSummary(fromDate, toDate);
  }, [fromDate, toDate, fetchSummary]);

  async function handleExport() {
    setExporting(true);
    try {
      await reportsApi.downloadExport(fromDate, toDate);
    } catch (err) {
      alert(`Export failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setExporting(false);
    }
  }

  const fillRatePct = summary ? `${Math.round(summary.avg_fill_rate * 100)}%` : '—';
  const attendRate =
    summary && summary.total_rsvps > 0
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

      {loading && <p className="loading-state">Loading report…</p>}
      {error && <p className="error-state">{error}</p>}

      {!loading && summary && (
        <>
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
                  <th>Yes</th>
                  <th>No</th>
                  <th>Maybe</th>
                  <th>Waitlist</th>
                  <th>Attended</th>
                  <th>Fill %</th>
                  <th>Attend %</th>
                  <th>Groups</th>
                </tr>
              </thead>
              <tbody>
                {summary.events.length === 0 ? (
                  <tr>
                    <td colSpan={13} className="empty-state">No events in this range.</td>
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
            <div className="export-actions">
              <button
                className="btn btn-primary"
                onClick={() => void handleExport()}
                disabled={exporting}
              >
                {exporting ? 'Exporting…' : 'Download CSV'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export { ReportsPage };
export type { EventSummaryRow };
