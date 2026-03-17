import { Response, Router } from 'express';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAnyAuthenticatedRole, requireEventCreatorOrAdmin } from '../middleware/rbac';
import { getPool, sql } from '../db';
import { sendRsvpConfirmation } from '../services/notifications';

const router = Router({ mergeParams: true });

const VALID_RESPONSES = ['yes', 'no', 'maybe', 'waitlist'] as const;
type RsvpResponse = (typeof VALID_RESPONSES)[number];

router.get('/', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res) => {
  try {
    const pool = await getPool();
    const eventId = req.params.eventId;

    const responseFilter = req.query.response as string | undefined;
    const request = pool.request().input('event_id', sql.UniqueIdentifier, eventId);
    let query = `
      SELECT er.response_id, er.event_id, er.member_id, er.response, er.responded_at, er.notes,
             m.first_name, m.last_name, m.email, m.mobile_phone
      FROM event_response er
      INNER JOIN member m ON m.member_id = er.member_id
      WHERE er.event_id = @event_id
    `;

    if (responseFilter) {
      query += ' AND er.response = @response';
      request.input('response', sql.NVarChar, responseFilter.toLowerCase());
    }

    query += ' ORDER BY er.responded_at DESC';
    const result = await request.query(query);
    res.json(result.recordset);
  } catch (error) {
    console.error('GET /events/:eventId/rsvp failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', writeLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res: Response) => {
  try {
    const pool = await getPool();
    const eventId = req.params.eventId;
    const memberId = req.body?.member_id as string | undefined;
    const response = (req.body?.response as string | undefined)?.toLowerCase() as RsvpResponse | undefined;
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : null;

    if (!memberId) {
      res.status(400).json({ error: 'member_id is required' });
      return;
    }

    if (!response || !VALID_RESPONSES.includes(response)) {
      res.status(400).json({ error: `response must be one of: ${VALID_RESPONSES.join(', ')}` });
      return;
    }

    const eventResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, eventId)
      .query<{ event_id: string; title: string; status: string; capacity: number | null }>(
        'SELECT event_id, title, status, capacity FROM event WHERE event_id = @event_id'
      );

    const event = eventResult.recordset[0];
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (event.status !== 'published') {
      res.status(409).json({ error: 'RSVPs are accepted only when event status is published' });
      return;
    }

    if (response === 'yes' && event.capacity && event.capacity > 0) {
      const countResult = await pool
        .request()
        .input('event_id', sql.UniqueIdentifier, eventId)
        .query<{ yes_count: number }>(
          "SELECT COUNT(*) AS yes_count FROM event_response WHERE event_id = @event_id AND response = 'yes'"
        );
      const yesCount = countResult.recordset[0]?.yes_count ?? 0;
      if (yesCount >= event.capacity) {
        res.status(409).json({ error: 'Event is full. Use waitlist response.' });
        return;
      }
    }

    const upsert = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, eventId)
      .input('member_id', sql.UniqueIdentifier, memberId)
      .input('response', sql.NVarChar, response)
      .input('notes', sql.NVarChar, notes)
      .query(
        `MERGE event_response AS target
         USING (SELECT @event_id AS event_id, @member_id AS member_id) AS source
         ON target.event_id = source.event_id AND target.member_id = source.member_id
         WHEN MATCHED THEN
           UPDATE SET response = @response, notes = @notes, responded_at = GETUTCDATE()
         WHEN NOT MATCHED THEN
           INSERT (response_id, event_id, member_id, response, responded_at, notes)
           VALUES (NEWID(), @event_id, @member_id, @response, GETUTCDATE(), @notes)
         OUTPUT INSERTED.*;`
      );

    const memberResult = await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .query<{ email: string | null; mobile_phone: string | null }>(
        'SELECT email, mobile_phone FROM member WHERE member_id = @member_id'
      );

    const member = memberResult.recordset[0];
    if (member) {
      sendRsvpConfirmation({
        eventId: event.event_id,
        eventTitle: event.title,
        recipientEmail: member.email ?? undefined,
        recipientPhone: member.mobile_phone ?? undefined,
      });
    }

    res.status(200).json(upsert.recordset[0]);
  } catch (error) {
    console.error('POST /events/:eventId/rsvp failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:memberId', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    const eventId = req.params.eventId;
    const memberId = req.params.memberId;

    const result = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, eventId)
      .input('member_id', sql.UniqueIdentifier, memberId)
      .query('DELETE FROM event_response WHERE event_id = @event_id AND member_id = @member_id');

    if ((result.rowsAffected[0] ?? 0) === 0) {
      res.status(404).json({ error: 'RSVP not found' });
      return;
    }

    res.status(204).send();
  } catch (error) {
    console.error('DELETE /events/:eventId/rsvp/:memberId failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;