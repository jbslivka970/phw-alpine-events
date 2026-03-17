import { Router, Request, Response } from 'express';

const router = Router();

// ---------------------------------------------------------------------------
// Types (mirrors PRD data model)
// ---------------------------------------------------------------------------

interface EventSummaryRow {
  event_id: string;
  title: string;
  start_date: string;
  location: string;
  status: string;
  capacity: number | null;
  rsvp_count: number;
  attended_count: number;
  targeted_groups: string[];
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

// ---------------------------------------------------------------------------
// GET /api/reports/summary
// Query params:
//   from  - YYYY-MM-DD  (defaults to first day of current month)
//   to    - YYYY-MM-DD  (defaults to today)
// ---------------------------------------------------------------------------

router.get('/summary', async (req: Request, res: Response) => {
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const defaultTo = now;

  const fromDate = parseDate(req.query.from, defaultFrom);
  const toDate = parseDate(req.query.to, defaultTo);

  // Normalise toDate to end-of-day
  toDate.setHours(23, 59, 59, 999);

  // TODO: replace placeholder with actual DB aggregation:
  //
  //   SELECT
  //     e.event_id, e.title, e.start_date, e.location, e.status,
  //     e.capacity,
  //     COUNT(DISTINCT r.rsvp_id)        AS rsvp_count,
  //     COUNT(DISTINCT a.attendance_id)  AS attended_count
  //   FROM event e
  //   LEFT JOIN event_rsvp       r ON r.event_id = e.event_id AND r.status = 'confirmed'
  //   LEFT JOIN event_attendance a ON a.event_id = e.event_id AND a.attended = 1
  //   WHERE e.start_date BETWEEN @fromDate AND @toDate
  //   GROUP BY e.event_id, e.title, e.start_date, e.location, e.status, e.capacity

  const payload: SummaryPayload = {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
    total_events: 0,
    total_rsvps: 0,
    total_attended: 0,
    avg_fill_rate: 0,
    events: [], // placeholder — DB integration pending
  };

  res.json(payload);
});

// ---------------------------------------------------------------------------
// GET /api/reports/export
// Query params:
//   format  - 'csv' | 'pdf'  (defaults to 'csv')
//   from    - YYYY-MM-DD
//   to      - YYYY-MM-DD
// ---------------------------------------------------------------------------

router.get('/export', async (req: Request, res: Response) => {
  const format = req.query.format === 'pdf' ? 'pdf' : 'csv';

  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const fromDate = parseDate(req.query.from, defaultFrom);
  const toDate = parseDate(req.query.to, now);
  toDate.setHours(23, 59, 59, 999);

  // TODO: implement export generation
  //   CSV: stream events+rsvp data as text/csv
  //   PDF: generate via a PDF library (e.g. pdfkit) and stream as application/pdf

  if (format === 'csv') {
    const filename = `phw-events-${fromDate.toISOString().slice(0, 10)}-to-${toDate.toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // Placeholder: header row only
    res.send('event_id,title,start_date,location,status,capacity,rsvp_count,attended_count\n');
  } else {
    // PDF export entry point — real implementation pending
    res.status(501).json({
      message: 'PDF export is not yet implemented.',
      format,
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
    });
  }
});

export default router;
