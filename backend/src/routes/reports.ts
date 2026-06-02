import { Router, Request, Response } from 'express';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { DEFAULT_TENANT_ID } from '../middleware/resolveTenantContext';
import { apiLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/rbac';
import { getAcsEmailProviderDeliveryStatus } from '../services/notifications';

const router = Router();

// ---------------------------------------------------------------------------
// Types (mirrors PRD data model)
// ---------------------------------------------------------------------------

interface EventSummaryRow {
  event_id: string;
  title: string;
  event_date: string;
  location: string | null;
  status: string;
  capacity: number | null;
  yes_count: number;
  no_count: number;
  maybe_count: number;
  waitlist_count: number;
  attended_count: number;
}

interface SummaryPayload {
  from: string;
  to: string;
  total_events: number;
  total_rsvps: number;
  total_attended: number;
  avg_fill_rate: number;
  events: EventSummaryRow[];
}

interface DeliverySummaryRow {
  channel: string;
  status: string;
  operation_type: string | null;
  count: number;
}

interface DeliverySummaryPayload {
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

interface DeliveryTrendPayload {
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
  channel: string;
  recipient: string;
  status: string;
  operation_type: string | null;
  operation_reason: string | null;
  provider_id: string | null;
  error_detail: string | null;
  provider_status: string | null;
  provider_error_detail: string | null;
  provider_checked_at: string | null;
  provider_source: string | null;
}

interface DeliveryLogPayload {
  from: string;
  to: string;
  page: number;
  page_size: number;
  total_rows: number;
  include_provider_status: boolean;
  rows: DeliveryLogRow[];
}

interface ReminderDuplicateRow {
  event_id: string;
  member_id: string;
  channel: string;
  send_count: number;
  first_sent_at: string;
  last_sent_at: string;
}

interface EventNotificationCoverageRow {
  member_id: string;
  email: string | null;
  mobile_phone: string | null;
  email_eligible: boolean;
  sms_eligible: boolean;
  attempted: boolean;
  delivered: boolean;
  failed: boolean;
  skipped: boolean;
  attempt_count: number;
  latest_email_status: string | null;
  latest_sms_status: string | null;
  latest_attempt_at: string | null;
  last_error_detail: string | null;
  inferred_reason: string;
}

type ReportEventTenantSupport = {
  hasTenantId: boolean;
};

let cachedReportEventTenantSupport: ReportEventTenantSupport | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseDate(value: unknown, fallback: Date): Date {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(value + 'T00:00:00');
    if (!isNaN(d.getTime())) return d;
  }
  return fallback;
}

function formatIsoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function optionalQueryValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'string') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.min(parsed, max);
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function parseUuidOrNull(value: string | null): string | null {
  if (!value) {
    return null;
  }

  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function deriveNoAttemptReason(emailEligible: boolean, smsEligible: boolean): string {
  if (!emailEligible && !smsEligible) {
    return 'no_eligible_channel';
  }

  if (!emailEligible) {
    return 'email_not_eligible';
  }

  return 'no_log_entry';
}

function isMultiTenantEnabled(): boolean {
  const raw = process.env['MULTI_TENANT_ENABLED'];
  if (!raw) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

async function getReportEventTenantSupport(pool: Awaited<ReturnType<typeof getPool>>): Promise<ReportEventTenantSupport> {
  if (cachedReportEventTenantSupport) {
    return cachedReportEventTenantSupport;
  }

  const result = await pool
    .request()
    .query<{ has_tenant_id: number }>(
      `SELECT CASE WHEN COL_LENGTH('dbo.event', 'tenant_id') IS NULL THEN 0 ELSE 1 END AS has_tenant_id`
    );

  cachedReportEventTenantSupport = {
    hasTenantId: result.recordset[0]?.has_tenant_id === 1,
  };

  return cachedReportEventTenantSupport;
}

async function ensureTenantEventAccess(
  req: Request,
  res: Response,
  pool: Awaited<ReturnType<typeof getPool>>,
  eventId: string,
): Promise<boolean> {
  const tenantId = (req.tenantId ?? DEFAULT_TENANT_ID).trim().toLowerCase();
  if (!isMultiTenantEnabled()) {
    return true;
  }

  const support = await getReportEventTenantSupport(pool);
  if (!support.hasTenantId) {
    return true;
  }

  const result = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .query<{ event_id: string }>(
      `SELECT TOP 1 event_id
       FROM event
       WHERE event_id = @event_id
         AND tenant_id = @tenant_id`
    );

  if (!result.recordset[0]) {
    res.status(404).json({ error: 'Event not found' });
    return false;
  }

  return true;
}

async function queryEventSummary(fromDate: Date, toDate: Date): Promise<EventSummaryRow[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('fromDate', sql.DateTime, fromDate)
    .input('toDate', sql.DateTime, toDate)
    .query<{
      event_id: string;
      title: string;
      event_date: Date;
      location: string | null;
      status: string;
      capacity: number | null;
      yes_count: number;
      no_count: number;
      maybe_count: number;
      waitlist_count: number;
      attended_count: number;
    }>(
      `SELECT
          e.event_id,
          e.title,
          e.event_date,
          e.location,
          e.status,
          e.capacity,
          SUM(CASE WHEN er.response = 'yes' THEN 1 ELSE 0 END) AS yes_count,
          SUM(CASE WHEN er.response = 'no' THEN 1 ELSE 0 END) AS no_count,
          SUM(CASE WHEN er.response = 'maybe' THEN 1 ELSE 0 END) AS maybe_count,
          SUM(CASE WHEN er.response = 'waitlist' THEN 1 ELSE 0 END) AS waitlist_count,
          SUM(CASE WHEN ea.attended = 1 THEN 1 ELSE 0 END) AS attended_count
       FROM event e
       LEFT JOIN event_response er ON er.event_id = e.event_id
       LEFT JOIN event_assignment ea ON ea.event_id = e.event_id
       WHERE e.event_date >= @fromDate
         AND e.event_date <= @toDate
       GROUP BY
          e.event_id,
          e.title,
          e.event_date,
          e.location,
          e.status,
          e.capacity
       ORDER BY e.event_date ASC`
    );

  return result.recordset.map((row) => ({
    event_id: row.event_id,
    title: row.title,
    event_date: row.event_date.toISOString(),
    location: row.location,
    status: row.status,
    capacity: row.capacity,
    yes_count: row.yes_count,
    no_count: row.no_count,
    maybe_count: row.maybe_count,
    waitlist_count: row.waitlist_count,
    attended_count: row.attended_count,
  }));
}

// ---------------------------------------------------------------------------
// GET /api/reports/summary
// Query params:
//   from  - YYYY-MM-DD  (defaults to first day of current month)
//   to    - YYYY-MM-DD  (defaults to today)
// ---------------------------------------------------------------------------

router.get('/summary', apiLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const defaultTo = now;

  const fromDate = parseDate(req.query.from, defaultFrom);
  const toDate = parseDate(req.query.to, defaultTo);

  // Normalise toDate to end-of-day
  toDate.setHours(23, 59, 59, 999);

  try {
    const events = await queryEventSummary(fromDate, toDate);
    const totalEvents = events.length;
    const totalRsvps = events.reduce((sum, row) => sum + row.yes_count + row.no_count + row.maybe_count + row.waitlist_count, 0);
    const totalAttended = events.reduce((sum, row) => sum + row.attended_count, 0);

    const fillRates = events
      .filter((row) => row.capacity !== null && row.capacity > 0)
      .map((row) => Math.min(1, row.yes_count / (row.capacity ?? 1)));
    const avgFillRate = fillRates.length > 0
      ? fillRates.reduce((sum, rate) => sum + rate, 0) / fillRates.length
      : 0;

    const payload: SummaryPayload = {
      from: formatIsoDate(fromDate),
      to: formatIsoDate(toDate),
      total_events: totalEvents,
      total_rsvps: totalRsvps,
      total_attended: totalAttended,
      avg_fill_rate: avgFillRate,
      events,
    };

    res.json(payload);
  } catch (error) {
    console.error('GET /reports/summary failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/reports/export
// Query params:
//   format  - 'csv' | 'pdf'  (defaults to 'csv')
//   from    - YYYY-MM-DD
//   to      - YYYY-MM-DD
// ---------------------------------------------------------------------------

router.get('/export', apiLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {

  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const fromDate = parseDate(req.query.from, defaultFrom);
  const toDate = parseDate(req.query.to, now);
  toDate.setHours(23, 59, 59, 999);

  try {
    const events = await queryEventSummary(fromDate, toDate);
    const filename = `phw-events-${formatIsoDate(fromDate)}-to-${formatIsoDate(toDate)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const header = [
      'event_id',
      'title',
      'event_date',
      'location',
      'status',
      'capacity',
      'yes_count',
      'no_count',
      'maybe_count',
      'waitlist_count',
    ].join(',');

    const rows = events.map((row) => ([
      row.event_id,
      csvSafe(row.title),
      row.event_date,
      csvSafe(row.location ?? ''),
      row.status,
      row.capacity ?? '',
      row.yes_count,
      row.no_count,
      row.maybe_count,
      row.waitlist_count,
    ].join(',')));

    res.send(`${header}\n${rows.join('\n')}\n`);
  } catch (error) {
    console.error('GET /reports/export failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/participation', apiLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {
  const yearRaw = typeof req.query.year === 'string' ? parseInt(req.query.year, 10) : new Date().getFullYear();
  const year = Number.isFinite(yearRaw) ? yearRaw : new Date().getFullYear();
  const priorYear = year - 1;

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('year', sql.Int, year)
      .input('priorYear', sql.Int, priorYear)
      .query<{
        member_id: string;
        first_name: string;
        last_name: string;
        events_attended: number;
        events_attended_prior_year: number;
      }>(
        `SELECT
            m.member_id,
            m.first_name,
            m.last_name,
            SUM(CASE WHEN YEAR(e.event_date) = @year AND ea.attended = 1 THEN 1 ELSE 0 END) AS events_attended,
            SUM(CASE WHEN YEAR(e.event_date) = @priorYear AND ea.attended = 1 THEN 1 ELSE 0 END) AS events_attended_prior_year
         FROM member m
         LEFT JOIN event_assignment ea ON ea.member_id = m.member_id
         LEFT JOIN event e ON e.event_id = ea.event_id AND e.status = 'completed'
         WHERE m.is_active = 1
         GROUP BY m.member_id, m.first_name, m.last_name
         ORDER BY events_attended ASC, m.last_name ASC, m.first_name ASC`
      );

    res.json({
      year,
      rows: result.recordset,
    });
  } catch (error) {
    console.error('GET /reports/participation failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/delivery', apiLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const fromDate = parseDate(req.query.from, defaultFrom);
  const toDate = parseDate(req.query.to, now);
  const channel = optionalQueryValue(req.query.channel);
  const status = optionalQueryValue(req.query.status);
  const operationType = optionalQueryValue(req.query.operation_type);
  toDate.setHours(23, 59, 59, 999);

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('fromDate', sql.DateTime, fromDate)
      .input('toDate', sql.DateTime, toDate)
      .input('channel', sql.NVarChar(16), channel)
      .input('status', sql.NVarChar(32), status)
      .input('operationType', sql.NVarChar(64), operationType)
      .query<DeliverySummaryRow>(
        `SELECT
            channel,
            status,
            operation_type,
            COUNT(*) AS count
         FROM notification_log
         WHERE sent_at >= @fromDate
           AND sent_at <= @toDate
           AND (@channel IS NULL OR channel = @channel)
           AND (@status IS NULL OR status = @status)
           AND (@operationType IS NULL OR operation_type = @operationType)
         GROUP BY channel, status, operation_type
         ORDER BY channel ASC, status ASC, operation_type ASC`
      );

    const payload: DeliverySummaryPayload = {
      from: formatIsoDate(fromDate),
      to: formatIsoDate(toDate),
      total_notifications: result.recordset.reduce((sum, row) => sum + row.count, 0),
      rows: result.recordset,
    };

    res.json(payload);
  } catch (error) {
    console.error('GET /reports/delivery failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/delivery/trends', apiLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const fromDate = parseDate(req.query.from, defaultFrom);
  const toDate = parseDate(req.query.to, now);
  const channel = optionalQueryValue(req.query.channel);
  const status = optionalQueryValue(req.query.status);
  const operationType = optionalQueryValue(req.query.operation_type);
  toDate.setHours(23, 59, 59, 999);

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('fromDate', sql.DateTime, fromDate)
      .input('toDate', sql.DateTime, toDate)
      .input('channel', sql.NVarChar(16), channel)
      .input('status', sql.NVarChar(32), status)
      .input('operationType', sql.NVarChar(64), operationType)
      .query<{
        day: Date;
        total_count: number;
        failed_count: number;
        successful_count: number;
        email_count: number;
        sms_count: number;
      }>(
        `SELECT
            CAST(sent_at AS date) AS day,
            COUNT(*) AS total_count,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
            SUM(CASE WHEN status IN ('sent', 'delivered', 'stubbed') THEN 1 ELSE 0 END) AS successful_count,
            SUM(CASE WHEN channel = 'email' THEN 1 ELSE 0 END) AS email_count,
            SUM(CASE WHEN channel = 'sms' THEN 1 ELSE 0 END) AS sms_count
         FROM notification_log
         WHERE sent_at >= @fromDate
           AND sent_at <= @toDate
           AND (@channel IS NULL OR channel = @channel)
           AND (@status IS NULL OR status = @status)
           AND (@operationType IS NULL OR operation_type = @operationType)
         GROUP BY CAST(sent_at AS date)
         ORDER BY day ASC`
      );

    const payload: DeliveryTrendPayload = {
      from: formatIsoDate(fromDate),
      to: formatIsoDate(toDate),
      rows: result.recordset.map((row) => ({
        day: row.day.toISOString().slice(0, 10),
        total_count: row.total_count,
        failed_count: row.failed_count,
        successful_count: row.successful_count,
        email_count: row.email_count,
        sms_count: row.sms_count,
      })),
    };

    res.json(payload);
  } catch (error) {
    console.error('GET /reports/delivery/trends failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/delivery/logs', apiLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const fromDate = parseDate(req.query.from, defaultFrom);
  const toDate = parseDate(req.query.to, now);
  const channel = optionalQueryValue(req.query.channel);
  const status = optionalQueryValue(req.query.status);
  const operationType = optionalQueryValue(req.query.operation_type);
  const eventId = parseUuidOrNull(optionalQueryValue(req.query.event_id));
  const pageSize = parsePositiveInt(req.query.page_size, 25, 100);
  const page = parsePositiveInt(req.query.page, 1, 5000);
  const includeProviderStatus = parseBoolean(req.query.include_provider_status, false);
  const offset = (page - 1) * pageSize;
  toDate.setHours(23, 59, 59, 999);

  try {
    const pool = await getPool();
    if (eventId && !(await ensureTenantEventAccess(req, res, pool, eventId))) {
      return;
    }

    const baseRequest = pool
      .request()
      .input('fromDate', sql.DateTime, fromDate)
      .input('toDate', sql.DateTime, toDate)
      .input('channel', sql.NVarChar(16), channel)
      .input('status', sql.NVarChar(32), status)
      .input('operationType', sql.NVarChar(64), operationType)
      .input('eventId', sql.UniqueIdentifier, eventId)
      .input('offset', sql.Int, offset)
      .input('pageSize', sql.Int, pageSize);

    const rowsResult = await baseRequest.query<{
      log_id: string;
      sent_at: Date;
      event_id: string | null;
      member_id: string | null;
      template_id: string | null;
      channel: string;
      recipient: string;
      status: string;
      operation_type: string | null;
      operation_reason: string | null;
      provider_id: string | null;
      error_detail: string | null;
    }>(
      `SELECT
          log_id,
          sent_at,
          event_id,
          member_id,
          template_id,
          channel,
          recipient,
          status,
          operation_type,
          operation_reason,
          provider_id,
          error_detail
       FROM notification_log
       WHERE sent_at >= @fromDate
         AND sent_at <= @toDate
         AND (@channel IS NULL OR channel = @channel)
         AND (@status IS NULL OR status = @status)
         AND (@operationType IS NULL OR operation_type = @operationType)
         AND (@eventId IS NULL OR event_id = @eventId)
       ORDER BY sent_at DESC
       OFFSET @offset ROWS
       FETCH NEXT @pageSize ROWS ONLY`
    );

    const countResult = await pool
      .request()
      .input('fromDate', sql.DateTime, fromDate)
      .input('toDate', sql.DateTime, toDate)
      .input('channel', sql.NVarChar(16), channel)
      .input('status', sql.NVarChar(32), status)
      .input('operationType', sql.NVarChar(64), operationType)
      .input('eventId', sql.UniqueIdentifier, eventId)
      .query<{ total_rows: number }>(
        `SELECT COUNT(*) AS total_rows
         FROM notification_log
         WHERE sent_at >= @fromDate
           AND sent_at <= @toDate
           AND (@channel IS NULL OR channel = @channel)
           AND (@status IS NULL OR status = @status)
           AND (@operationType IS NULL OR operation_type = @operationType)
           AND (@eventId IS NULL OR event_id = @eventId)`
      );

    const providerStatusByLogId = new Map<string, {
      provider_status: string | null;
      provider_error_detail: string | null;
      provider_checked_at: string;
      provider_source: string;
    }>();

    if (includeProviderStatus) {
      const eligibleRows = rowsResult.recordset.filter((row) => row.channel === 'email' && Boolean(row.provider_id));
      await Promise.all(
        eligibleRows.map(async (row) => {
          const statusResult = await getAcsEmailProviderDeliveryStatus(row.provider_id as string);
          providerStatusByLogId.set(row.log_id, statusResult);
        })
      );
    }

    const payload: DeliveryLogPayload = {
      from: formatIsoDate(fromDate),
      to: formatIsoDate(toDate),
      page,
      page_size: pageSize,
      total_rows: countResult.recordset[0]?.total_rows ?? 0,
      include_provider_status: includeProviderStatus,
      rows: rowsResult.recordset.map((row) => {
        const providerStatus = providerStatusByLogId.get(row.log_id);
        return {
          log_id: row.log_id,
          sent_at: row.sent_at.toISOString(),
          event_id: row.event_id,
          member_id: row.member_id,
          template_id: row.template_id,
          channel: row.channel,
          recipient: row.recipient,
          status: row.status,
          operation_type: row.operation_type,
          operation_reason: row.operation_reason,
          provider_id: row.provider_id,
          error_detail: row.error_detail,
          provider_status: providerStatus?.provider_status ?? null,
          provider_error_detail: providerStatus?.provider_error_detail ?? null,
          provider_checked_at: providerStatus?.provider_checked_at ?? null,
          provider_source: providerStatus?.provider_source ?? null,
        };
      }),
    };

    res.json(payload);
  } catch (error) {
    console.error('GET /reports/delivery/logs failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/reminders', apiLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {
  const now = new Date();
  const defaultFrom = new Date(now);
  defaultFrom.setDate(now.getDate() - 30);

  const fromDate = parseDate(req.query.from, defaultFrom);
  const toDate = parseDate(req.query.to, now);
  toDate.setHours(23, 59, 59, 999);

  try {
    const pool = await getPool();
    const duplicates = await pool
      .request()
      .input('fromDate', sql.DateTime, fromDate)
      .input('toDate', sql.DateTime, toDate)
      .query<{
        event_id: string;
        member_id: string;
        channel: string;
        send_count: number;
        first_sent_at: Date;
        last_sent_at: Date;
      }>(
        `SELECT
            event_id,
            member_id,
            channel,
            COUNT(*) AS send_count,
            MIN(sent_at) AS first_sent_at,
            MAX(sent_at) AS last_sent_at
         FROM notification_log
         WHERE operation_type = 'event_reminder'
           AND event_id IS NOT NULL
           AND member_id IS NOT NULL
           AND sent_at >= @fromDate
           AND sent_at <= @toDate
           AND status IN ('sent', 'delivered', 'stubbed')
         GROUP BY event_id, member_id, channel
         HAVING COUNT(*) > 1
         ORDER BY send_count DESC, last_sent_at DESC`
      );

    const reminderTotals = await pool
      .request()
      .input('fromDate', sql.DateTime, fromDate)
      .input('toDate', sql.DateTime, toDate)
      .query<{ total_reminder_notifications: number }>(
        `SELECT COUNT(*) AS total_reminder_notifications
         FROM notification_log
         WHERE operation_type = 'event_reminder'
           AND sent_at >= @fromDate
           AND sent_at <= @toDate`
      );

    const rows: ReminderDuplicateRow[] = duplicates.recordset.map((row) => ({
      event_id: row.event_id,
      member_id: row.member_id,
      channel: row.channel,
      send_count: row.send_count,
      first_sent_at: row.first_sent_at.toISOString(),
      last_sent_at: row.last_sent_at.toISOString(),
    }));

    res.json({
      from: formatIsoDate(fromDate),
      to: formatIsoDate(toDate),
      total_reminder_notifications: reminderTotals.recordset[0]?.total_reminder_notifications ?? 0,
      duplicate_count: rows.length,
      rows,
    });
  } catch (error) {
    console.error('GET /reports/reminders failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/delivery/event/:eventId/coverage', apiLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {
  const eventId = parseUuidOrNull(req.params.eventId);
  if (!eventId) {
    res.status(400).json({ error: 'eventId must be a valid UUID.' });
    return;
  }

  const operationType = optionalQueryValue(req.query.operation_type) ?? 'event_published';
  if (operationType !== 'event_published') {
    res.status(400).json({ error: 'Unsupported operation_type. Currently only event_published is supported.' });
    return;
  }

  try {
    const pool = await getPool();
    if (!(await ensureTenantEventAccess(req, res, pool, eventId))) {
      return;
    }

    const targetResult = await pool
      .request()
      .input('eventId', sql.UniqueIdentifier, eventId)
      .query<{
        member_id: string;
        email: string | null;
        mobile_phone: string | null;
        email_opt_out: boolean;
        sms_opt_in: boolean;
      }>(
        `SELECT DISTINCT
            m.member_id,
            m.email,
            m.mobile_phone,
            ISNULL(m.email_opt_out, 0) AS email_opt_out,
            ISNULL(m.sms_opt_in, 0) AS sms_opt_in
         FROM event_notification_target ent
         LEFT JOIN member_group mg ON mg.group_id = ent.group_id
         LEFT JOIN member m ON m.member_id = COALESCE(ent.member_id, mg.member_id)
         WHERE ent.event_id = @eventId
           AND m.member_id IS NOT NULL`
      );

    const logsResult = await pool
      .request()
      .input('eventId', sql.UniqueIdentifier, eventId)
      .input('operationType', sql.NVarChar(64), operationType)
      .query<{
        member_id: string;
        channel: string;
        status: string;
        error_detail: string | null;
        sent_at: Date;
      }>(
        `SELECT
            member_id,
            channel,
            status,
            error_detail,
            sent_at
         FROM notification_log
         WHERE event_id = @eventId
           AND operation_type = @operationType
           AND member_id IS NOT NULL
         ORDER BY sent_at DESC`
      );

    const logsByMember = new Map<string, Array<{ channel: string; status: string; error_detail: string | null; sent_at: Date }>>();
    for (const row of logsResult.recordset) {
      const bucket = logsByMember.get(row.member_id) ?? [];
      bucket.push(row);
      logsByMember.set(row.member_id, bucket);
    }

    const rows: EventNotificationCoverageRow[] = targetResult.recordset.map((target) => {
      const memberLogs = logsByMember.get(target.member_id) ?? [];
      const emailEligible = Boolean(target.email && !target.email_opt_out);
      const smsEligible = Boolean(target.mobile_phone && target.sms_opt_in);
      const attempted = memberLogs.length > 0;
      const delivered = memberLogs.some((entry) => ['sent', 'delivered', 'stubbed'].includes(entry.status));
      const failed = memberLogs.some((entry) => entry.status === 'failed');
      const skipped = memberLogs.some((entry) => entry.status === 'skipped');
      const latestAttemptAt = memberLogs[0]?.sent_at ? memberLogs[0].sent_at.toISOString() : null;
      const latestEmailStatus = memberLogs.find((entry) => entry.channel === 'email')?.status ?? null;
      const latestSmsStatus = memberLogs.find((entry) => entry.channel === 'sms')?.status ?? null;
      const lastError = memberLogs.find((entry) => Boolean(entry.error_detail))?.error_detail ?? null;
      const inferredReason = attempted
        ? (failed ? 'attempt_failed' : skipped ? 'attempt_skipped' : 'attempt_logged')
        : deriveNoAttemptReason(emailEligible, smsEligible);

      return {
        member_id: target.member_id,
        email: target.email,
        mobile_phone: target.mobile_phone,
        email_eligible: emailEligible,
        sms_eligible: smsEligible,
        attempted,
        delivered,
        failed,
        skipped,
        attempt_count: memberLogs.length,
        latest_email_status: latestEmailStatus,
        latest_sms_status: latestSmsStatus,
        latest_attempt_at: latestAttemptAt,
        last_error_detail: lastError,
        inferred_reason: inferredReason,
      };
    });

    const summary = {
      targeted_members: rows.length,
      email_eligible_members: rows.filter((row) => row.email_eligible).length,
      sms_eligible_members: rows.filter((row) => row.sms_eligible).length,
      attempted_members: rows.filter((row) => row.attempted).length,
      delivered_members: rows.filter((row) => row.delivered).length,
      failed_members: rows.filter((row) => row.failed).length,
      skipped_members: rows.filter((row) => row.skipped).length,
      no_attempt_members: rows.filter((row) => !row.attempted).length,
    };

    res.json({
      event_id: eventId,
      operation_type: operationType,
      generated_at: new Date().toISOString(),
      summary,
      rows,
    });
  } catch (error) {
    console.error('GET /reports/delivery/event/:eventId/coverage failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function csvSafe(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

export default router;
