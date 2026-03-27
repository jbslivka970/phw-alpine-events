import { Router, Request, Response } from 'express';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/rbac';

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

interface ReminderDuplicateRow {
  event_id: string;
  member_id: string;
  channel: string;
  send_count: number;
  first_sent_at: string;
  last_sent_at: string;
}

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

function csvSafe(value: string): string {
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

export default router;
