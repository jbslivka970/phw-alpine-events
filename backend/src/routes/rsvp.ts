import { Response, Router } from 'express';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAnyAuthenticatedRole, requireEventCreatorOrAdmin } from '../middleware/rbac';
import { getPool, sql } from '../db';
import { inferResponseRoleForMember, recordRsvpResponse, triggerWaitlistAutoPromotion, VALID_RESPONSES, RsvpError, type RsvpResponse } from '../services/rsvpService';

const router = Router({ mergeParams: true });
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function splitDisplayName(name: string | undefined, fallbackEmail: string): { firstName: string; lastName: string } {
  const base = (name ?? '').trim();
  if (!base) {
    const localPart = fallbackEmail.split('@')[0] ?? 'member';
    return { firstName: localPart.slice(0, 80), lastName: 'Member' };
  }

  const pieces = base.split(/\s+/).filter(Boolean);
  if (pieces.length === 1) {
    return { firstName: pieces[0]!.slice(0, 80), lastName: 'Member' };
  }

  return {
    firstName: (pieces.shift() ?? 'Member').slice(0, 80),
    lastName: pieces.join(' ').slice(0, 80) || 'Member',
  };
}

async function resolveCurrentMemberId(user: Response['locals']['user'] | undefined): Promise<string | null> {
  const email = user?.email?.trim().toLowerCase();
  if (!email) {
    return null;
  }

  const pool = await getPool();
  const existing = await pool
    .request()
    .input('email', sql.NVarChar, email)
    .query<{ member_id: string }>('SELECT TOP 1 member_id FROM member WHERE LOWER(email) = @email ORDER BY is_active DESC, updated_at DESC');

  if (existing.recordset[0]?.member_id) {
    return existing.recordset[0].member_id;
  }

  const { firstName, lastName } = splitDisplayName(user?.name, email);

  try {
    const created = await pool
      .request()
      .input('first_name', sql.NVarChar, firstName)
      .input('last_name', sql.NVarChar, lastName)
      .input('email', sql.NVarChar, email)
      .query<{ member_id: string }>(
        `INSERT INTO member
           (first_name, last_name, email, mobile_phone, sms_opt_in, email_opt_out, source)
         OUTPUT INSERTED.member_id
         VALUES
           (@first_name, @last_name, @email, NULL, 0, 0, 'manual')`
      );

    return created.recordset[0]?.member_id ?? null;
  } catch {
    const raced = await pool
      .request()
      .input('email', sql.NVarChar, email)
      .query<{ member_id: string }>('SELECT TOP 1 member_id FROM member WHERE LOWER(email) = @email ORDER BY is_active DESC, updated_at DESC');
    return raced.recordset[0]?.member_id ?? null;
  }
}

function requiresExplicitRole(response: RsvpResponse): boolean {
  return response === 'yes' || response === 'maybe' || response === 'waitlist';
}

router.get('/', apiLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    const eventId = req.params.eventId;

    const responseFilter = req.query.response as string | undefined;
    const request = pool.request().input('event_id', sql.UniqueIdentifier, eventId);
    let query = `
      SELECT er.response_id, er.event_id, er.member_id, er.response_role, er.response, er.responded_at, er.notes,
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
    const requestedMemberId = req.body?.member_id as string | undefined;
    const response = (req.body?.response as string | undefined)?.toLowerCase() as RsvpResponse | undefined;
    const parsedResponseRole = (req.body?.response_role as string | undefined)?.toUpperCase();
    const notes = typeof req.body?.notes === 'string' ? req.body.notes : null;
    const memberId = (typeof requestedMemberId === 'string' && UUID_PATTERN.test(requestedMemberId))
      ? requestedMemberId
      : await resolveCurrentMemberId(req.user);

    if (!memberId) {
      res.status(400).json({ error: 'member_id is required and could not be inferred from the authenticated profile' });
      return;
    }

    if (!response || !VALID_RESPONSES.includes(response)) {
      res.status(400).json({ error: `response must be one of: ${VALID_RESPONSES.join(', ')}` });
      return;
    }

    if (parsedResponseRole !== undefined && !['MENTOR', 'PARTICIPANT'].includes(parsedResponseRole)) {
      res.status(400).json({ error: 'response_role must be MENTOR or PARTICIPANT when provided' });
      return;
    }

    const inferredResponseRole = parsedResponseRole
      ? undefined
      : await inferResponseRoleForMember({ memberId });
    const responseRole = (parsedResponseRole ?? inferredResponseRole) as 'MENTOR' | 'PARTICIPANT' | undefined;

    if (requiresExplicitRole(response) && !responseRole) {
      res.status(400).json({ error: 'response_role is required for yes, maybe, and waitlist responses when member role is ambiguous' });
      return;
    }

    const upsert = await recordRsvpResponse({
      eventId,
      memberId,
      response,
      notes,
      responseChannel: 'web',
      responseRole,
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