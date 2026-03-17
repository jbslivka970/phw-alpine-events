import { Router, Request, Response } from 'express';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimiter';
import { requireAnyAuthenticatedRole } from '../middleware/rbac';

const router = Router();

/**
 * GET /api/calendar
 * Query params:
 *   month  - YYYY-MM  (defaults to current month)
 *
 * Returns events whose event_date falls within the requested month.
 */
router.get('/', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req: Request, res: Response) => {
  const { month } = req.query as { month?: string };

  const now = new Date();
  let year = now.getFullYear();
  let monthIndex = now.getMonth();

  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const parts = month.split('-');
    year = parseInt(parts[0], 10);
    monthIndex = parseInt(parts[1], 10) - 1;
  }

  if (monthIndex < 0 || monthIndex > 11) {
    res.status(400).json({ error: 'Invalid month query parameter. Expected YYYY-MM.' });
    return;
  }

  const rangeStart = new Date(year, monthIndex, 1);
  const rangeEnd = new Date(year, monthIndex + 1, 1);

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('range_start', sql.DateTime, rangeStart)
      .input('range_end', sql.DateTime, rangeEnd)
      .query<{
        event_id: string;
        title: string;
        event_date: Date;
        location: string | null;
        status: 'draft' | 'published' | 'cancelled' | 'completed';
        capacity: number | null;
        yes_count: number;
        maybe_count: number;
        waitlist_count: number;
        targeted_groups_csv: string | null;
      }>(
        `SELECT
            e.event_id,
            e.title,
            e.event_date,
            e.location,
            e.status,
            e.capacity,
            SUM(CASE WHEN er.response = 'yes' THEN 1 ELSE 0 END) AS yes_count,
            SUM(CASE WHEN er.response = 'maybe' THEN 1 ELSE 0 END) AS maybe_count,
            SUM(CASE WHEN er.response = 'waitlist' THEN 1 ELSE 0 END) AS waitlist_count,
            target_groups.targeted_groups_csv
         FROM event e
         LEFT JOIN event_response er ON er.event_id = e.event_id
         LEFT JOIN (
            SELECT
              ent.event_id,
              STRING_AGG(g.group_name, ', ') AS targeted_groups_csv
            FROM event_notification_target ent
            INNER JOIN [group] g ON g.group_id = ent.group_id
            GROUP BY ent.event_id
         ) target_groups ON target_groups.event_id = e.event_id
         WHERE e.event_date >= @range_start
           AND e.event_date < @range_end
         GROUP BY
            e.event_id,
            e.title,
            e.event_date,
            e.location,
            e.status,
            e.capacity,
            target_groups.targeted_groups_csv
         ORDER BY e.event_date ASC`
      );

    res.json({
      month: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
      range_start: rangeStart.toISOString(),
      range_end: new Date(year, monthIndex + 1, 0, 23, 59, 59, 999).toISOString(),
      events: result.recordset.map((row) => ({
        event_id: row.event_id,
        title: row.title,
        event_date: row.event_date.toISOString(),
        location: row.location,
        status: row.status,
        capacity: row.capacity,
        yes_count: row.yes_count,
        maybe_count: row.maybe_count,
        waitlist_count: row.waitlist_count,
        targeted_groups: row.targeted_groups_csv
          ? row.targeted_groups_csv.split(', ').filter(Boolean)
          : [],
      })),
    });
  } catch (error) {
    console.error('GET /calendar failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
