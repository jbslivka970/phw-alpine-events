import { Router, Request, Response } from 'express';

const router = Router();

/**
 * GET /api/calendar
 * Query params:
 *   month  - YYYY-MM  (defaults to current month)
 *
 * Returns events whose start_date falls within the requested month.
 * Full database integration is a TODO; this returns a structured placeholder.
 */
router.get('/', async (req: Request, res: Response) => {
  const { month } = req.query as { month?: string };

  // Parse or default to current month
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

  // TODO: replace placeholder with actual DB query:
  //   SELECT e.*, COUNT(r.rsvp_id) AS rsvp_count
  //   FROM event e
  //   LEFT JOIN event_rsvp r ON r.event_id = e.event_id AND r.status = 'confirmed'
  //   WHERE e.start_date >= @rangeStart AND e.start_date <= @rangeEnd
  //   GROUP BY e.event_id, ...

  res.json({
    month: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
    range_start: rangeStart.toISOString(),
    range_end: rangeEnd.toISOString(),
    events: [], // placeholder — DB integration pending
  });
});

export default router;
