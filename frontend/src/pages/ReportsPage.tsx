import { useEffect, useState } from 'react';
import { reportsApi } from '../api/reports';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventSummaryRow {
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

export interface ReportSummary {
  total_events: number;
  total_rsvps: number;
  total_attended: number;
  avg_fill_rate: number; // 0–1
  events: EventSummaryRow[];
}

interface DeliverySummaryRow {
  channel: 'email' | 'sms';
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'stubbed' | 'skipped';
  operation_type: string | null;
  count: number;
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
  const startDate = new Date(row.event_date).toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const rsvpCount = row.yes_count + row.no_count + row.maybe_count + row.waitlist_count;
  const fillRate =
    row.capacity !== null && row.capacity > 0
      ? `${Math.round((row.yes_count / row.capacity) * 100)}%`
      : '—';
  const attendRate =
    rsvpCount > 0
      ? `${Math.round((row.attended_count / rsvpCount) * 100)}%`
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
      <td>{row.yes_count}</td>
      <td>{row.no_count}</td>
      <td>{row.maybe_count}</td>
      <td>{row.waitlist_count}</td>
      <td>{row.attended_count}</td>
      <td>{fillRate}</td>
      <td>{attendRate}</td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Export button group (reusable)
// ---------------------------------------------------------------------------

function ExportButtons({ fromDate, toDate }: { fromDate: string; toDate: string }) {
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  async function onExport() {
    setIsExporting(true);
    setExportError(null);
    try {
      await reportsApi.downloadExport(fromDate, toDate);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Export failed.');
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="export-actions">
      <button
        className="btn btn-primary"
        onClick={onExport}
        disabled={isExporting}
      >
        {isExporting ? 'Exporting…' : 'Export CSV'}
      </button>
      {exportError && <p className="members-error">{exportError}</p>}
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
  const [summary, setSummary] = useState<ReportSummary>({
    total_events: 0,
    total_rsvps: 0,
    total_attended: 0,
    avg_fill_rate: 0,
    events: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deliveryRows, setDeliveryRows] = useState<DeliverySummaryRow[]>([]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    reportsApi
      .summary(fromDate, toDate)
      .then((data) => {
        if (!active) {
          return;
        }
        setSummary({
          total_events: data.total_events,
          total_rsvps: data.total_rsvps,
          total_attended: data.total_attended,
          avg_fill_rate: data.avg_fill_rate,
          events: data.events as EventSummaryRow[],
        });
      })
      .catch((err: unknown) => {
        if (!active) {
          return;
        }
        setError(err instanceof Error ? err.message : 'Failed to load report summary.');
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [fromDate, toDate]);

  useEffect(() => {
    let active = true;
    reportsApi
      .delivery(fromDate, toDate)
      .then((data) => {
        if (!active) {
          return;
        }
        setDeliveryRows(data.rows as DeliverySummaryRow[]);
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setDeliveryRows([]);
      });

    return () => {
      active = false;
    };
  }, [fromDate, toDate]);

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
      {error && <p className="members-error">{error}</p>}
      {loading && <p className="members-loading">Loading report summary...</p>}
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
            </tr>
          </thead>
          <tbody>
            {summary.events.length === 0 ? (
              <tr>
                <td colSpan={12} className="empty-state">No events in this range.</td>
              </tr>
            ) : (
              summary.events.map((row) => <SummaryRow key={row.event_id} row={row} />)
            )}
          </tbody>
        </table>
      </div>

      <div className="summary-table-wrapper">
        <h2>Notification Delivery Breakdown</h2>
        <table className="summary-table">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Status</th>
              <th>Operation</th>
              <th>Count</th>
            </tr>
          </thead>
          <tbody>
            {deliveryRows.length === 0 ? (
              <tr>
                <td colSpan={4} className="empty-state">No notification activity in this range.</td>
              </tr>
            ) : (
              deliveryRows.map((row, index) => (
                <tr key={`${row.channel}-${row.status}-${row.operation_type ?? 'none'}-${index}`}>
                  <td>{row.channel}</td>
                  <td>{row.status}</td>
                  <td>{row.operation_type ?? 'general'}</td>
                  <td>{row.count}</td>
                </tr>
              ))
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
