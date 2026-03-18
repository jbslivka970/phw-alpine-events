import { getPool, sql } from '../db';
import { sendRsvpConfirmation } from './notifications';

const VALID_RESPONSES = ['yes', 'no', 'maybe', 'waitlist'] as const;
type RsvpResponse = (typeof VALID_RESPONSES)[number];

interface PendingEvent {
  event_id: string;
  title: string;
  event_date: Date;
  location: string | null;
}

interface RecordedRsvp {
  response_id: string;
  event_id: string;
  member_id: string;
  response: RsvpResponse;
  responded_at: Date;
  notes: string | null;
}

class RsvpError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'RsvpError';
  }
}

async function listPendingEventsForMember(memberId: string): Promise<PendingEvent[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query<PendingEvent>(
      `SELECT DISTINCT
          e.event_id,
          e.title,
          e.event_date,
          e.location
       FROM event_notification_target ent
       INNER JOIN event e ON e.event_id = ent.event_id
       LEFT JOIN member_group mg ON mg.group_id = ent.group_id
       INNER JOIN member m ON m.member_id = COALESCE(ent.member_id, mg.member_id)
       LEFT JOIN event_response er ON er.event_id = e.event_id AND er.member_id = m.member_id
       WHERE m.member_id = @member_id
         AND e.status = 'published'
         AND e.event_date >= GETUTCDATE()
         AND er.response_id IS NULL
       ORDER BY e.event_date ASC`
    );

  return result.recordset;
}

async function recordRsvpResponse(options: {
  eventId: string;
  memberId: string;
  response: RsvpResponse;
  notes?: string | null;
}): Promise<RecordedRsvp> {
  const pool = await getPool();
  const notes = options.notes ?? null;

  const eventResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, options.eventId)
    .query<{ event_id: string; title: string; status: string; capacity: number | null; event_date: Date }>(
      'SELECT event_id, title, status, capacity, event_date FROM event WHERE event_id = @event_id'
    );

  const event = eventResult.recordset[0];
  if (!event) {
    throw new RsvpError('Event not found', 404);
  }

  if (event.status !== 'published') {
    throw new RsvpError('RSVPs are accepted only when event status is published', 409);
  }

  if (options.response === 'yes' && event.capacity && event.capacity > 0) {
    const countResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, options.eventId)
      .query<{ yes_count: number }>(
        "SELECT COUNT(*) AS yes_count FROM event_response WHERE event_id = @event_id AND response = 'yes'"
      );
    const yesCount = countResult.recordset[0]?.yes_count ?? 0;
    if (yesCount >= event.capacity) {
      throw new RsvpError('Event is full. Use waitlist response.', 409);
    }
  }

  const upsert = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, options.eventId)
    .input('member_id', sql.UniqueIdentifier, options.memberId)
    .input('response', sql.NVarChar, options.response)
    .input('notes', sql.NVarChar, notes)
    .query<RecordedRsvp>(
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
    .input('member_id', sql.UniqueIdentifier, options.memberId)
    .query<{ first_name: string; email: string | null; mobile_phone: string | null; sms_opt_in: boolean }>(
      'SELECT first_name, email, mobile_phone, sms_opt_in FROM member WHERE member_id = @member_id'
    );

  const member = memberResult.recordset[0];
  if (member) {
    sendRsvpConfirmation({
      eventId: event.event_id,
      eventTitle: event.title,
      eventDate: new Date(event.event_date).toLocaleString(),
      firstName: member.first_name,
      memberId: options.memberId,
      rsvpStatus: options.response,
      recipientEmail: member.email ?? undefined,
      recipientPhone: member.sms_opt_in ? (member.mobile_phone ?? undefined) : undefined,
    });
  }

  return upsert.recordset[0];
}

export { VALID_RESPONSES, RsvpError, listPendingEventsForMember, recordRsvpResponse };
export type { PendingEvent, RecordedRsvp, RsvpResponse };