import { Router } from 'express';
import { getPool, sql } from '../db';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { recordRsvpResponse, RsvpError, VALID_RESPONSES, type RsvpResponse } from '../services/rsvpService';
import { verifyRsvpToken } from '../services/rsvpLinkService';

const router = Router();

function getToken(query: Record<string, unknown>): string {
  const queryToken = query.token;
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }

  throw new Error('token is required');
}

router.get('/', apiLimiter, async (req, res) => {
  try {
    const token = verifyRsvpToken(getToken(req.query));
    const pool = await getPool();
    const result = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, token.eventId)
      .input('member_id', sql.UniqueIdentifier, token.memberId)
      .query<{
        event_id: string;
        title: string;
        description: string | null;
        location: string | null;
        event_date: string;
        end_date: string | null;
        capacity: number | null;
        status: string;
        member_id: string;
        first_name: string | null;
        current_response: string | null;
      }>(
        `SELECT
            e.event_id,
            e.title,
            e.description,
            e.location,
            e.event_date,
            e.end_date,
            e.capacity,
            e.status,
            m.member_id,
            m.first_name,
            er.response AS current_response
         FROM event e
         INNER JOIN member m ON m.member_id = @member_id
         LEFT JOIN event_response er ON er.event_id = e.event_id AND er.member_id = m.member_id
         WHERE e.event_id = @event_id`
      );

    const row = result.recordset[0];
    if (!row) {
      res.status(404).json({ error: 'Event invite not found' });
      return;
    }

    res.json({
      ...row,
      token_expires_at: token.expiresAt ?? null,
    });
  } catch (error) {
    console.error('GET /rsvp failed', error);
    res.status(401).json({ error: error instanceof Error ? error.message : 'Invalid or expired RSVP token' });
  }
});

router.post('/', writeLimiter, async (req, res) => {
  try {
    const token = verifyRsvpToken(getToken(req.query));
    const response = (req.body?.response as string | undefined)?.toLowerCase();

    if (!response || !VALID_RESPONSES.includes(response as RsvpResponse)) {
      res.status(400).json({ error: `response must be one of: ${VALID_RESPONSES.join(', ')}` });
      return;
    }

    const record = await recordRsvpResponse({
      eventId: token.eventId,
      memberId: token.memberId,
      response: response as RsvpResponse,
      notes: 'Recorded from tokenized RSVP link',
      responseChannel: 'tokenized_link',
      groupContextId: token.groupContextId ?? null,
    });

    res.json(record);
  } catch (error) {
    if (error instanceof RsvpError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    console.error('POST /rsvp failed', error);
    res.status(401).json({ error: error instanceof Error ? error.message : 'Invalid or expired RSVP token' });
  }
});

export default router;