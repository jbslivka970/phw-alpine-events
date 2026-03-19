import { Response, Router } from 'express';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAnyAuthenticatedRole, requireEventCreatorOrAdmin } from '../middleware/rbac';
import { getPool, sql } from '../db';
import { recordRsvpResponse, triggerWaitlistAutoPromotion, VALID_RESPONSES, RsvpError, type RsvpResponse } from '../services/rsvpService';

const router = Router({ mergeParams: true });

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

    const upsert = await recordRsvpResponse({
      eventId,
      memberId,
      response,
      notes,
      responseChannel: 'web',
    });
    res.status(200).json(upsert);
  } catch (error) {
    if (error instanceof RsvpError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
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

    await triggerWaitlistAutoPromotion(eventId);

    res.status(204).send();
  } catch (error) {
    console.error('DELETE /events/:eventId/rsvp/:memberId failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;