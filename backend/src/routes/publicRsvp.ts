import { Router } from 'express';
import { getPool, sql } from '../db';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { inferResponseRoleForMember, recordRsvpResponse, RsvpError, VALID_RESPONSES, type RsvpResponse } from '../services/rsvpService';
import { verifyRsvpToken } from '../services/rsvpLinkService';

const router = Router();

function getToken(query: Record<string, unknown>): string {
  const queryToken = query.token;
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }

  throw new Error('token is required');
}

function parseResponseRole(value: unknown): 'MENTOR' | 'PARTICIPANT' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === 'MENTOR' || normalized === 'PARTICIPANT') {
    return normalized;
  }

  return undefined;
}

function requiresExplicitRole(response: RsvpResponse): boolean {
  return response === 'yes' || response === 'maybe' || response === 'waitlist';
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
        current_response_role: 'MENTOR' | 'PARTICIPANT' | null;
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
            er.response AS current_response,
            er.response_role AS current_response_role
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
      inferred_response_role: (await inferResponseRoleForMember({
        memberId: token.memberId,
        groupContextId: token.groupContextId ?? null,
      })) ?? null,
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
    const parsedResponseRole = parseResponseRole(req.body?.response_role);
    const inferredResponseRole = parsedResponseRole
      ? undefined
      : await inferResponseRoleForMember({
        memberId: token.memberId,
        groupContextId: token.groupContextId ?? null,
      });
    const responseRole = parsedResponseRole ?? inferredResponseRole;

    if (!response || !VALID_RESPONSES.includes(response as RsvpResponse)) {
      res.status(400).json({ error: `response must be one of: ${VALID_RESPONSES.join(', ')}` });
      return;
    }

    if (req.body?.response_role !== undefined && !parsedResponseRole) {
      res.status(400).json({ error: 'response_role must be MENTOR or PARTICIPANT when provided' });
      return;
    }

    if (requiresExplicitRole(response as RsvpResponse) && !responseRole) {
      res.status(400).json({ error: 'response_role is required for yes, maybe, and waitlist responses when member role is ambiguous' });
      return;
    }

    const record = await recordRsvpResponse({
      eventId: token.eventId,
      memberId: token.memberId,
      response: response as RsvpResponse,
      notes: 'Recorded from tokenized RSVP link',
      responseChannel: 'tokenized_link',
      groupContextId: token.groupContextId ?? null,
      responseRole,
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