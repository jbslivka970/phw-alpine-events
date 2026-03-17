import { Router, Request, Response } from 'express';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/rbac';

const router = Router();

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

function escapeCsv(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ---------------------------------------------------------------------------
// GET /api/v1/reports/summary
// Query params:
//   from  - YYYY-MM-DD  (defaults to first day of current month)
//   to    - YYYY-MM-DD  (defaults to today)
// ---------------------------------------------------------------------------

router.get('/summary', apiLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const fromDate = parseDate(req.query.from, defaultFrom);
  const toDate = parseDate(req.query.to, now);
  toDate.setHours(23, 59, 59, 999);

  try {
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
           (SELECT COUNT(*) FROM event_response er WHERE er.event_id = e.event_id AND er.response = 'yes')       AS yes_count,
           (SELECT COUNT(*) FROM event_response er WHERE er.event_id = e.event_id AND er.response = 'no')        AS no_count,
           (SELECT COUNT(*) FROM event_response er WHERE er.event_id = e.event_id AND er.response = 'maybe')     AS maybe_count,
           (SELECT COUNT(*) FROM event_response er WHERE er.event_id = e.event_id AND er.response = 'waitlist')  AS waitlist_count,
           (SELECT COUNT(*) FROM event_assignment ea WHERE ea.event_id = e.event_id AND ea.attended = 1)         AS attended_count
         FROM event e
         WHERE e.event_date BETWEEN @fromDate AND @toDate
         ORDER BY e.event_date ASC`
      );

    const events = await Promise.all(
      result.recordset.map(async (ev) => {
        const targetsResult = await pool
          .request()
          .input('event_id', sql.UniqueIdentifier, ev.event_id)
          .query<{ name: string }>(
            `SELECT g.name
             FROM event_notification_target ent
             INNER JOIN [group] g ON g.group_id = ent.group_id
             WHERE ent.event_id = @event_id`
          );
        return {
          ...ev,
          targeted_groups: targetsResult.recordset.map((r) => r.name),
        };
      })
    );

    const totalEvents = events.length;
    const totalRsvps = events.reduce((sum, e) => sum + e.yes_count, 0);
    const totalAttended = events.reduce((sum, e) => sum + e.attended_count, 0);
    const totalCapacity = events.reduce((sum, e) => sum + (e.capacity ?? 0), 0);
    const avgFillRate = totalCapacity > 0
      ? Math.round((totalRsvps / totalCapacity) * 100) / 100
      : 0;

    res.json({
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
      total_events: totalEvents,
      total_rsvps: totalRsvps,
      total_attended: totalAttended,
      avg_fill_rate: avgFillRate,
      events,
    });
  } catch (error) {
    console.error('GET /reports/summary failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/reports/export
// Query params:
//   from  - YYYY-MM-DD
//   to    - YYYY-MM-DD
// ---------------------------------------------------------------------------

router.get('/export', apiLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const fromDate = parseDate(req.query.from, defaultFrom);
  const toDate = parseDate(req.query.to, now);
  toDate.setHours(23, 59, 59, 999);

  try {
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
      }>(
        `SELECT
           e.event_id,
           e.title,
           e.event_date,
           e.location,
           e.status,
           e.capacity,
           (SELECT COUNT(*) FROM event_response er WHERE er.event_id = e.event_id AND er.response = 'yes')       AS yes_count,
           (SELECT COUNT(*) FROM event_response er WHERE er.event_id = e.event_id AND er.response = 'no')        AS no_count,
           (SELECT COUNT(*) FROM event_response er WHERE er.event_id = e.event_id AND er.response = 'maybe')     AS maybe_count,
           (SELECT COUNT(*) FROM event_response er WHERE er.event_id = e.event_id AND er.response = 'waitlist')  AS waitlist_count
         FROM event e
         WHERE e.event_date BETWEEN @fromDate AND @toDate
         ORDER BY e.event_date ASC`
      );

    const filename = `phw-events-${fromDate.toISOString().slice(0, 10)}-to-${toDate.toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const header = 'event_id,title,event_date,location,status,capacity,yes_count,no_count,maybe_count,waitlist_count\n';
    res.write(header);

    for (const ev of result.recordset) {
      const row = [
        escapeCsv(ev.event_id),
        escapeCsv(ev.title),
        escapeCsv(ev.event_date ? new Date(ev.event_date).toISOString().slice(0, 10) : null),
        escapeCsv(ev.location),
        escapeCsv(ev.status),
        escapeCsv(ev.capacity),
        escapeCsv(ev.yes_count),
        escapeCsv(ev.no_count),
        escapeCsv(ev.maybe_count),
        escapeCsv(ev.waitlist_count),
      ].join(',') + '\n';
      res.write(row);
    }

    res.end();
  } catch (error) {
    console.error('GET /reports/export failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/v1/reports/participation
// Query params:
//   year  - YYYY  (defaults to current year)
// ---------------------------------------------------------------------------

router.get('/participation', apiLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {
  const year = parseInt((req.query.year as string) || String(new Date().getFullYear()), 10);
  const priorYear = year - 1;

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('yearStart', sql.DateTime, new Date(year, 0, 1))
      .input('yearEnd', sql.DateTime, new Date(year, 11, 31, 23, 59, 59))
      .input('priorYearStart', sql.DateTime, new Date(priorYear, 0, 1))
      .input('priorYearEnd', sql.DateTime, new Date(priorYear, 11, 31, 23, 59, 59))
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
           (SELECT COUNT(*)
            FROM event_assignment ea
            INNER JOIN event e ON e.event_id = ea.event_id
            WHERE ea.member_id = m.member_id AND ea.attended = 1
              AND e.event_date BETWEEN @yearStart AND @yearEnd) AS events_attended,
           (SELECT COUNT(*)
            FROM event_assignment ea
            INNER JOIN event e ON e.event_id = ea.event_id
            WHERE ea.member_id = m.member_id AND ea.attended = 1
              AND e.event_date BETWEEN @priorYearStart AND @priorYearEnd) AS events_attended_prior_year
         FROM member m
         WHERE m.is_active = 1
         ORDER BY events_attended ASC, m.last_name ASC`
      );

    res.json({ year, members: result.recordset });
  } catch (error) {
    console.error('GET /reports/participation failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
