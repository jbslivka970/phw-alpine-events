import { Router, Request, Response } from 'express';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter } from '../middleware/rateLimiter';
import { requireAnyAuthenticatedRole } from '../middleware/rbac';

const router = Router();

/**
 * GET /api/v1/calendar
 * Query params:
 *   month  - YYYY-MM  (defaults to current month)
 *
 * Returns events whose event_date falls within the requested month,
 * with RSVP counts and notification target group names.
 */
router.get('/', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req: Request, res: Response) => {
  const { month } = req.query as { month?: string };

  const now = new Date();
  let year = now.getFullYear();
  let monthIndex = now.getMonth(); // 0-based

  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const parts = month.split('-');
    year = parseInt(parts[0], 10);
    monthIndex = parseInt(parts[1], 10) - 1;
  }

  const rangeStart = new Date(year, monthIndex, 1);
  const rangeEnd = new Date(year, monthIndex + 1, 0, 23, 59, 59);

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('rangeStart', sql.DateTime, rangeStart)
      .input('rangeEnd', sql.DateTime, rangeEnd)
      .query<{
        event_id: string;
        title: string;
        event_date: Date;
        location: string | null;
        status: string;
        capacity: number | null;
        yes_count: number;
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
           (SELECT COUNT(*) FROM event_response er WHERE er.event_id = e.event_id AND er.response = 'maybe')     AS maybe_count,
           (SELECT COUNT(*) FROM event_response er WHERE er.event_id = e.event_id AND er.response = 'waitlist') AS waitlist_count
         FROM event e
         WHERE e.event_date >= @rangeStart AND e.event_date <= @rangeEnd
         ORDER BY e.event_date ASC`
      );

    // Attach notification target group names per event
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

    res.json({
      month: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
      range_start: rangeStart.toISOString(),
      range_end: rangeEnd.toISOString(),
      events,
    });
  } catch (error) {
    console.error('GET /calendar failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
