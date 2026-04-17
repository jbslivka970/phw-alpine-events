import { useEffect, useState } from 'react';
import { reportsApi } from '../api/reports';
import type {
  DeliveryFilters,
  DeliveryLogRow,
  DeliveryTrendRow,
  EventDeliveryCoverageResponse,
} from '../api/reports';

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

function formatDateTime(isoDateTime: string): string {
  return new Date(isoDateTime).toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatShortDay(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00`).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim())
}

function DeliveryTrendChart({ rows }: { rows: DeliveryTrendRow[] }) {
  if (rows.length === 0) {
    return <p className="members-loading">No delivery trend data in this range.</p>;
  }

  const maxCount = Math.max(...rows.map((row) => row.total_count), 1);

  return (
    <div className="trend-chart">
      {rows.map((row) => {
        const heightPct = Math.max(8, Math.round((row.total_count / maxCount) * 100));
        const failPct = row.total_count > 0 ? Math.round((row.failed_count / row.total_count) * 100) : 0;
        return (
          <div key={row.day} className="trend-chart__col" title={`${row.day}: ${row.total_count} total, ${row.failed_count} failed`}>
            <div className="trend-chart__bar-wrap">
              <div className="trend-chart__bar" style={{ height: `${heightPct}%` }} />
            </div>
            <span className="trend-chart__count">{row.total_count}</span>
            <span className="trend-chart__label">{formatShortDay(row.day)}</span>
            <span className={`trend-chart__fail${failPct > 0 ? ' trend-chart__fail--bad' : ''}`}>{failPct}% fail</span>
          </div>
        );
      })}
    </div>
  );
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
  const startDate = new Date(row.event_date).toLocaleString('en-GB', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
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
  const [deliveryTrends, setDeliveryTrends] = useState<DeliveryTrendRow[]>([]);
  const [deliveryLogs, setDeliveryLogs] = useState<DeliveryLogRow[]>([]);
  const [deliveryLogsTotal, setDeliveryLogsTotal] = useState(0);
  const [deliveryLogsLoading, setDeliveryLogsLoading] = useState(false);
  const [deliveryLogsError, setDeliveryLogsError] = useState<string | null>(null);
  const [deliveryPage, setDeliveryPage] = useState(1);
  const [providerStatusEnabled, setProviderStatusEnabled] = useState(false);
  const [providerRefreshTick, setProviderRefreshTick] = useState(0);
  const [deliveryChannel, setDeliveryChannel] = useState<'all' | 'email' | 'sms'>('all');
  const [deliveryStatus, setDeliveryStatus] = useState<'all' | 'queued' | 'sent' | 'delivered' | 'failed' | 'stubbed' | 'skipped'>('all');
  const [deliveryOperation, setDeliveryOperation] = useState('');
  const [deliveryEventId, setDeliveryEventId] = useState('');
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageError, setCoverageError] = useState<string | null>(null);
  const [coverageData, setCoverageData] = useState<EventDeliveryCoverageResponse | null>(null);

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
    const filters: DeliveryFilters = {
      channel: deliveryChannel === 'all' ? undefined : deliveryChannel,
      status: deliveryStatus === 'all' ? undefined : deliveryStatus,
      operation_type: deliveryOperation.trim() || undefined,
    };

    reportsApi
      .delivery(fromDate, toDate, filters)
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

    reportsApi
      .deliveryTrends(fromDate, toDate, filters)
      .then((data) => {
        if (!active) {
          return;
        }
        setDeliveryTrends(data.rows as DeliveryTrendRow[]);
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setDeliveryTrends([]);
      });

    return () => {
      active = false;
    };
  }, [fromDate, toDate, deliveryChannel, deliveryStatus, deliveryOperation]);

  useEffect(() => {
    setDeliveryPage(1);
  }, [fromDate, toDate, deliveryChannel, deliveryStatus, deliveryOperation]);

  useEffect(() => {
    let active = true;
    const filters: DeliveryFilters & { event_id?: string; page?: number; page_size?: number; include_provider_status?: boolean } = {
      channel: deliveryChannel === 'all' ? undefined : deliveryChannel,
      status: deliveryStatus === 'all' ? undefined : deliveryStatus,
      operation_type: deliveryOperation.trim() || undefined,
      event_id: deliveryEventId.trim() || undefined,
      page: deliveryPage,
      page_size: 25,
      include_provider_status: providerStatusEnabled,
    };

    setDeliveryLogsLoading(true);
    setDeliveryLogsError(null);
    reportsApi
      .deliveryLogs(fromDate, toDate, filters)
      .then((data) => {
        if (!active) {
          return;
        }
        setDeliveryLogs(data.rows as DeliveryLogRow[]);
        setDeliveryLogsTotal(data.total_rows);
      })
      .catch((err: unknown) => {
        if (!active) {
          return;
        }
        setDeliveryLogs([]);
        setDeliveryLogsTotal(0);
        setDeliveryLogsError(err instanceof Error ? err.message : 'Failed to load delivery logs.');
      })
      .finally(() => {
        if (active) {
          setDeliveryLogsLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [fromDate, toDate, deliveryChannel, deliveryStatus, deliveryOperation, deliveryEventId, deliveryPage, providerStatusEnabled, providerRefreshTick]);

  useEffect(() => {
    const eventId = deliveryEventId.trim();
    if (!isUuidV4(eventId)) {
      setCoverageData(null);
      setCoverageError(null);
      setCoverageLoading(false);
      return;
    }

    let active = true;
    setCoverageLoading(true);
    setCoverageError(null);
    reportsApi
      .deliveryEventCoverage(eventId, 'event_published')
      .then((data) => {
        if (!active) {
          return;
        }
        setCoverageData(data);
      })
      .catch((err: unknown) => {
        if (!active) {
          return;
        }
        setCoverageData(null);
        setCoverageError(err instanceof Error ? err.message : 'Failed to load event coverage report.');
      })
      .finally(() => {
        if (active) {
          setCoverageLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [deliveryEventId]);

  const trendTotals = deliveryTrends.reduce(
    (acc, row) => {
      acc.total += row.total_count;
      acc.failed += row.failed_count;
      return acc;
    },
    { total: 0, failed: 0 }
  );
  const trendFailureRate = trendTotals.total > 0
    ? `${Math.round((trendTotals.failed / trendTotals.total) * 100)}%`
    : '0%';
  const logPageSize = 25;
  const totalLogPages = Math.max(1, Math.ceil(deliveryLogsTotal / logPageSize));

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
        <label>
          Channel
          <select value={deliveryChannel} onChange={(e) => setDeliveryChannel(e.target.value as 'all' | 'email' | 'sms')}>
            <option value="all">All</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
          </select>
        </label>
        <label>
          Status
          <select
            value={deliveryStatus}
            onChange={(e) => setDeliveryStatus(e.target.value as 'all' | 'queued' | 'sent' | 'delivered' | 'failed' | 'stubbed' | 'skipped')}
          >
            <option value="all">All</option>
            <option value="queued">Queued</option>
            <option value="sent">Sent</option>
            <option value="delivered">Delivered</option>
            <option value="failed">Failed</option>
            <option value="stubbed">Stubbed</option>
            <option value="skipped">Skipped</option>
          </select>
        </label>
        <label>
          Operation
          <input
            type="text"
            value={deliveryOperation}
            placeholder="event_invite"
            onChange={(e) => setDeliveryOperation(e.target.value)}
          />
        </label>
        <label>
          Event ID
          <input
            type="text"
            value={deliveryEventId}
            placeholder="optional UUID"
            onChange={(e) => {
              setDeliveryEventId(e.target.value);
              setDeliveryPage(1);
            }}
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
        <h2>Delivery Trends</h2>
        <div className="delivery-trend-kpis">
          <div className="delivery-trend-kpi">
            <span className="delivery-trend-kpi__value">{trendTotals.total}</span>
            <span className="delivery-trend-kpi__label">Total Notifications</span>
          </div>
          <div className="delivery-trend-kpi">
            <span className="delivery-trend-kpi__value">{trendFailureRate}</span>
            <span className="delivery-trend-kpi__label">Failure Rate</span>
          </div>
        </div>
        <DeliveryTrendChart rows={deliveryTrends} />
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

      <div className="summary-table-wrapper">
        <div className="delivery-log-header">
          <h2>Recent Delivery Attempts</h2>
          <div className="delivery-log-actions">
            <button
              className="btn btn-secondary"
              onClick={() => {
                setProviderStatusEnabled(true);
                setProviderRefreshTick((value) => value + 1);
              }}
              disabled={deliveryLogsLoading}
            >
              {deliveryLogsLoading && providerStatusEnabled ? 'Refreshing…' : 'Refresh Provider Status'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setProviderStatusEnabled(false);
                setProviderRefreshTick((value) => value + 1);
              }}
              disabled={deliveryLogsLoading || !providerStatusEnabled}
            >
              Hide Provider Status
            </button>
          </div>
        </div>

        {deliveryLogsError && <p className="members-error">{deliveryLogsError}</p>}
        {deliveryLogsLoading && <p className="members-loading">Loading delivery logs...</p>}

        <table className="summary-table">
          <thead>
            <tr>
              <th>Sent At</th>
              <th>Channel</th>
              <th>Recipient</th>
              <th>Status</th>
              <th>Provider Status</th>
              <th>Operation</th>
              <th>Event ID</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {deliveryLogs.length === 0 ? (
              <tr>
                <td colSpan={8} className="empty-state">No delivery logs in this range.</td>
              </tr>
            ) : (
              deliveryLogs.map((row) => (
                <tr key={row.log_id}>
                  <td>{formatDateTime(row.sent_at)}</td>
                  <td>{row.channel}</td>
                  <td>{row.recipient}</td>
                  <td>{row.status}</td>
                  <td>
                    {providerStatusEnabled
                      ? (row.provider_status ?? (row.channel === 'sms' ? 'Not available for SMS pull' : 'No provider status'))
                      : 'Hidden'}
                  </td>
                  <td>{row.operation_type ?? 'general'}</td>
                  <td className="delivery-log-event-id">{row.event_id ?? '—'}</td>
                  <td className="delivery-log-error-cell">{row.provider_error_detail ?? row.error_detail ?? '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        <div className="delivery-log-pagination">
          <button
            className="btn btn-secondary"
            disabled={deliveryPage <= 1 || deliveryLogsLoading}
            onClick={() => setDeliveryPage((value) => Math.max(1, value - 1))}
          >
            Prev
          </button>
          <span>Page {deliveryPage} of {totalLogPages}</span>
          <button
            className="btn btn-secondary"
            disabled={deliveryPage >= totalLogPages || deliveryLogsLoading}
            onClick={() => setDeliveryPage((value) => Math.min(totalLogPages, value + 1))}
          >
            Next
          </button>
        </div>
      </div>

      <div className="summary-table-wrapper">
        <h2>Event Audit Coverage</h2>
        <p className="card__body">
          Enter an Event ID above to view per-member coverage for published notifications.
        </p>
        {!isUuidV4(deliveryEventId) && (
          <p className="members-loading">Provide a valid Event ID to load audit coverage.</p>
        )}
        {isUuidV4(deliveryEventId) && coverageLoading && (
          <p className="members-loading">Loading event audit coverage…</p>
        )}
        {coverageError && <p className="members-error">{coverageError}</p>}
        {coverageData && (
          <>
            <div className="stat-grid" style={{ marginBottom: '0.75rem' }}>
              <StatCard label="Targeted" value={coverageData.summary.targeted_members} />
              <StatCard label="Attempted" value={coverageData.summary.attempted_members} />
              <StatCard label="Delivered" value={coverageData.summary.delivered_members} />
              <StatCard label="Failed" value={coverageData.summary.failed_members} />
              <StatCard label="Skipped" value={coverageData.summary.skipped_members} />
              <StatCard label="No Attempt" value={coverageData.summary.no_attempt_members} />
            </div>
            <table className="summary-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Email Eligible</th>
                  <th>SMS Eligible</th>
                  <th>Attempted</th>
                  <th>Delivered</th>
                  <th>Failed</th>
                  <th>Skipped</th>
                  <th>Attempts</th>
                  <th>Reason</th>
                  <th>Last Attempt</th>
                </tr>
              </thead>
              <tbody>
                {coverageData.rows.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="empty-state">No targeted members found for this event.</td>
                  </tr>
                ) : (
                  coverageData.rows.map((row) => (
                    <tr key={row.member_id}>
                      <td>{row.email ?? '—'}</td>
                      <td>{row.mobile_phone ?? '—'}</td>
                      <td>{row.email_eligible ? 'yes' : 'no'}</td>
                      <td>{row.sms_eligible ? 'yes' : 'no'}</td>
                      <td>{row.attempted ? 'yes' : 'no'}</td>
                      <td>{row.delivered ? 'yes' : 'no'}</td>
                      <td>{row.failed ? 'yes' : 'no'}</td>
                      <td>{row.skipped ? 'yes' : 'no'}</td>
                      <td>{row.attempt_count}</td>
                      <td>{row.inferred_reason}</td>
                      <td>{row.latest_attempt_at ? formatDateTime(row.latest_attempt_at) : '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </>
        )}
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
