import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { AuthenticatedRequest, requireAuth } from '../middleware/auth';
import getPool from '../db';
import { sendRsvpConfirmation } from '../services/notifications';

const router = Router({ mergeParams: true });

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(apiLimiter);

// Valid RSVP responses
const VALID_RESPONSES = ['YES', 'NO', 'MAYBE', 'WAITLIST'] as const;
type RsvpResponse = (typeof VALID_RESPONSES)[number];

// ----------------------------------------------------------------
// GET /events/:eventId/rsvp  – list all RSVPs for an event
// ----------------------------------------------------------------
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pool = await getPool();
    const { eventId } = req.params;
    const { response, role } = req.query;

    const request = pool.request().input('eventId', eventId);
    let query = `
      SELECT r.*, m.first_name, m.last_name, m.email, m.mobile_phone,
             g.name AS group_name
      FROM rsvp r
      JOIN member m ON m.member_id = r.member_id
      LEFT JOIN [group] g ON g.group_id = r.group_id
      WHERE r.event_id = @eventId
    `;

    if (response) {
      query += ` AND r.response = @response`;
      request.input('response', response as string);
    }
    if (role) {
      query += ` AND r.role = @role`;
      request.input('role', role as string);
    }

    query += ` ORDER BY r.created_at`;
    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) {
    console.error('GET /events/:eventId/rsvp error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ----------------------------------------------------------------
// POST /events/:eventId/rsvp  – create or update an RSVP
// ----------------------------------------------------------------
router.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { eventId } = req.params;
  const {
    member_id,
    response: rsvpResponse,
    role = 'participant',
    group_id,
    group_context,
    notes,
  } = req.body;

  if (!member_id) {
    res.status(400).json({ error: 'member_id is required' });
    return;
  }
  if (!VALID_RESPONSES.includes(rsvpResponse as RsvpResponse)) {
    res.status(400).json({ error: `response must be one of: ${VALID_RESPONSES.join(', ')}` });
    return;
  }
  if (!['mentor', 'participant'].includes(role)) {
    res.status(400).json({ error: 'role must be mentor or participant' });
    return;
  }

  try {
    const pool = await getPool();

    // Verify event exists and is published
    const eventResult = await pool
      .request()
      .input('eventId', eventId)
      .query(`SELECT event_id, title, status, mentor_slots, participant_slots,
                     mentor_slots_filled, participant_slots_filled
              FROM [event] WHERE event_id = @eventId`);

    if (eventResult.recordset.length === 0) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const event = eventResult.recordset[0];
    if (event.status !== 'PUBLISHED') {
      res.status(409).json({ error: 'RSVPs are only accepted for PUBLISHED events' });
      return;
    }

    // Check for existing RSVP
    const existing = await pool
      .request()
      .input('eventId', eventId)
      .input('memberId', member_id)
      .query(`SELECT rsvp_id, response, role FROM rsvp WHERE event_id = @eventId AND member_id = @memberId`);

    let rsvpRecord;

    if (existing.recordset.length > 0) {
      // Update existing
      const oldRecord = existing.recordset[0];
      const result = await pool
        .request()
        .input('rsvpId', oldRecord.rsvp_id)
        .input('response', rsvpResponse)
        .input('role', role)
        .input('groupId', group_id ?? null)
        .input('groupContext', group_context ? JSON.stringify(group_context) : null)
        .input('notes', notes ?? null)
        .query(`
          UPDATE rsvp
          SET response = @response, role = @role, group_id = @groupId,
              group_context = @groupContext, notes = @notes, updated_at = GETDATE()
          OUTPUT INSERTED.*
          WHERE rsvp_id = @rsvpId
        `);
      rsvpRecord = result.recordset[0];

      // Recalculate slots for old vs new role/response changes
      await recalculateSlots(pool, eventId);
    } else {
      // Check slot availability before inserting YES
      if (rsvpResponse === 'YES') {
        const slotsKey = role === 'mentor' ? 'mentor_slots' : 'participant_slots';
        const filledKey = role === 'mentor' ? 'mentor_slots_filled' : 'participant_slots_filled';
        if (event[slotsKey] > 0 && event[filledKey] >= event[slotsKey]) {
          // Auto-waitlist when slots are full
          res.status(409).json({
            error: 'No slots available',
            suggestion: 'Use WAITLIST response to join the waitlist',
          });
          return;
        }
      }

      const result = await pool
        .request()
        .input('eventId', eventId)
        .input('memberId', member_id)
        .input('response', rsvpResponse)
        .input('role', role)
        .input('groupId', group_id ?? null)
        .input('groupContext', group_context ? JSON.stringify(group_context) : null)
        .input('notes', notes ?? null)
        .query(`
          INSERT INTO rsvp (event_id, member_id, response, role, group_id, group_context, notes)
          OUTPUT INSERTED.*
          VALUES (@eventId, @memberId, @response, @role, @groupId, @groupContext, @notes)
        `);
      rsvpRecord = result.recordset[0];

      // Update filled slot counts
      await recalculateSlots(pool, eventId);
    }

    // Stub notification
    const memberResult = await pool
      .request()
      .input('memberId', member_id)
      .query(`SELECT email, mobile_phone FROM member WHERE member_id = @memberId`);
    if (memberResult.recordset.length > 0) {
      const member = memberResult.recordset[0];
      sendRsvpConfirmation({
        eventId,
        eventTitle: event.title,
        recipientEmail: member.email,
        recipientPhone: member.mobile_phone,
      });
    }

    res.status(existing.recordset.length > 0 ? 200 : 201).json(rsvpRecord);
  } catch (err) {
    console.error('POST /events/:eventId/rsvp error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ----------------------------------------------------------------
// DELETE /events/:eventId/rsvp/:memberId  – cancel an RSVP
// ----------------------------------------------------------------
router.delete('/:memberId', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const { eventId, memberId } = req.params;

  try {
    const pool = await getPool();
    const existing = await pool
      .request()
      .input('eventId', eventId)
      .input('memberId', memberId)
      .query(`SELECT rsvp_id FROM rsvp WHERE event_id = @eventId AND member_id = @memberId`);

    if (existing.recordset.length === 0) {
      res.status(404).json({ error: 'RSVP not found' });
      return;
    }

    await pool
      .request()
      .input('rsvpId', existing.recordset[0].rsvp_id)
      .query(`DELETE FROM rsvp WHERE rsvp_id = @rsvpId`);

    await recalculateSlots(pool, eventId);
    res.status(204).send();
  } catch (err) {
    console.error('DELETE /events/:eventId/rsvp/:memberId error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ----------------------------------------------------------------
// Helper: recalculate filled slot counts for an event
// ----------------------------------------------------------------
async function recalculateSlots(pool: Awaited<ReturnType<typeof getPool>>, eventId: string): Promise<void> {
  await pool
    .request()
    .input('eventId', eventId)
    .query(`
      UPDATE [event]
      SET mentor_slots_filled =
            (SELECT COUNT(*) FROM rsvp WHERE event_id = @eventId AND role = 'mentor' AND response = 'YES'),
          participant_slots_filled =
            (SELECT COUNT(*) FROM rsvp WHERE event_id = @eventId AND role = 'participant' AND response = 'YES'),
          updated_at = GETDATE()
      WHERE event_id = @eventId
    `);
}

export default router;
