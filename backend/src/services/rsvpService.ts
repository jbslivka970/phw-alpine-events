import { getPool, sql } from '../db';
import { sendRsvpConfirmation, sendWaitlistPromotionNotification } from './notifications';

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
  group_context_id: string | null;
  response_channel: string | null;
  response: RsvpResponse;
  responded_at: Date;
  notes: string | null;
  reminder_sent: boolean;
  reminder_sent_at: Date | null;
}

class RsvpError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'RsvpError';
  }
}

const WAITLIST_OFFER_WINDOW_HOURS = Number.parseInt(process.env.WAITLIST_OFFER_WINDOW_HOURS ?? '48', 10);

interface PromotionCandidate {
  member_id: string;
  response_channel: string | null;
  responded_at: Date;
  first_name: string | null;
  email: string | null;
  mobile_phone: string | null;
  sms_opt_in: boolean;
  email_opt_out: boolean;
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
  responseChannel?: string;
  groupContextId?: string | null;
}): Promise<RecordedRsvp> {
  const pool = await getPool();
  const notes = options.notes ?? null;
  const responseChannel = options.responseChannel ?? 'web';
  const groupContextId = options.groupContextId ?? null;

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

    const reservationResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, options.eventId)
      .input('member_id', sql.UniqueIdentifier, options.memberId)
      .query<{ reserved_count: number; has_active_offer: number }>(
        `SELECT
            SUM(CASE WHEN status = 'offered' AND expires_at > GETUTCDATE() AND member_id <> @member_id THEN 1 ELSE 0 END) AS reserved_count,
            SUM(CASE WHEN status = 'offered' AND expires_at > GETUTCDATE() AND member_id = @member_id THEN 1 ELSE 0 END) AS has_active_offer
         FROM waitlist_promotion_offer
         WHERE event_id = @event_id`
      );

    const reservedCount = reservationResult.recordset[0]?.reserved_count ?? 0;
    const hasActiveOffer = (reservationResult.recordset[0]?.has_active_offer ?? 0) > 0;
    if (yesCount + reservedCount >= event.capacity && !hasActiveOffer) {
      throw new RsvpError('Event is full. Use waitlist response.', 409);
    }
  }

  const upsert = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, options.eventId)
    .input('member_id', sql.UniqueIdentifier, options.memberId)
    .input('response', sql.NVarChar, options.response)
    .input('notes', sql.NVarChar, notes)
    .input('response_channel', sql.NVarChar, responseChannel)
    .input('group_context_id', sql.UniqueIdentifier, groupContextId)
    .query<RecordedRsvp>(
      `MERGE event_response AS target
       USING (SELECT @event_id AS event_id, @member_id AS member_id) AS source
       ON target.event_id = source.event_id AND target.member_id = source.member_id
       WHEN MATCHED THEN
         UPDATE SET
           response = @response,
           notes = @notes,
           responded_at = GETUTCDATE(),
           response_channel = @response_channel,
           group_context_id = COALESCE(@group_context_id, target.group_context_id)
       WHEN NOT MATCHED THEN
         INSERT (
           response_id,
           event_id,
           member_id,
           group_context_id,
           response_channel,
           response,
           responded_at,
           notes,
           reminder_sent,
           reminder_sent_at
         )
         VALUES (
           NEWID(),
           @event_id,
           @member_id,
           @group_context_id,
           @response_channel,
           @response,
           GETUTCDATE(),
           @notes,
           0,
           NULL
         )
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

  await reconcileWaitlistOfferForMember(options.eventId, options.memberId, options.response);
  await triggerWaitlistAutoPromotion(options.eventId);

  return upsert.recordset[0];
}

async function reconcileWaitlistOfferForMember(
  eventId: string,
  memberId: string,
  response: RsvpResponse
): Promise<void> {
  const pool = await getPool();
  const nextStatus = response === 'yes' ? 'accepted' : response === 'waitlist' ? 'offered' : 'declined';

  if (response === 'waitlist') {
    return;
  }

  await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('status', sql.NVarChar, nextStatus)
    .query(
      `UPDATE waitlist_promotion_offer
       SET status = @status, resolved_at = GETUTCDATE()
       WHERE event_id = @event_id
         AND member_id = @member_id
         AND status = 'offered'
         AND expires_at > GETUTCDATE()`
    );
}

async function triggerWaitlistAutoPromotion(eventId: string): Promise<void> {
  const pool = await getPool();

  const eventResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .query<{ event_id: string; title: string; event_date: Date; location: string | null; description: string | null; status: string; capacity: number | null }>(
      'SELECT event_id, title, event_date, location, description, status, capacity FROM event WHERE event_id = @event_id'
    );

  const event = eventResult.recordset[0];
  if (!event || event.status !== 'published' || !event.capacity || event.capacity <= 0) {
    return;
  }

  await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .query(
      `UPDATE waitlist_promotion_offer
       SET status = 'expired', resolved_at = GETUTCDATE()
       WHERE event_id = @event_id
         AND status = 'offered'
         AND expires_at <= GETUTCDATE()`
    );

  const countsResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .query<{ yes_count: number; active_offers: number }>(
      `SELECT
          (SELECT COUNT(*) FROM event_response WHERE event_id = @event_id AND response = 'yes') AS yes_count,
          (SELECT COUNT(*) FROM waitlist_promotion_offer WHERE event_id = @event_id AND status = 'offered' AND expires_at > GETUTCDATE()) AS active_offers`
    );

  const yesCount = countsResult.recordset[0]?.yes_count ?? 0;
  const activeOffers = countsResult.recordset[0]?.active_offers ?? 0;
  let availableSlots = event.capacity - yesCount - activeOffers;

  while (availableSlots > 0) {
    const candidateResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, eventId)
      .query<PromotionCandidate>(
        `SELECT TOP 1
            er.member_id,
            er.response_channel,
            er.responded_at,
            m.first_name,
            m.email,
            m.mobile_phone,
            m.sms_opt_in,
            m.email_opt_out
         FROM event_response er
         INNER JOIN member m ON m.member_id = er.member_id
         WHERE er.event_id = @event_id
           AND er.response = 'waitlist'
           AND NOT EXISTS (
             SELECT 1
             FROM waitlist_promotion_offer wpo
             WHERE wpo.event_id = er.event_id
               AND wpo.member_id = er.member_id
               AND wpo.status = 'offered'
               AND wpo.expires_at > GETUTCDATE()
           )
         ORDER BY er.responded_at ASC`
      );

    const candidate = candidateResult.recordset[0];
    if (!candidate) {
      break;
    }

    await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, eventId)
      .input('member_id', sql.UniqueIdentifier, candidate.member_id)
      .input('offered_until_hours', sql.Int, Number.isFinite(WAITLIST_OFFER_WINDOW_HOURS) ? WAITLIST_OFFER_WINDOW_HOURS : 48)
      .query(
        `INSERT INTO waitlist_promotion_offer (offer_id, event_id, member_id, status, offered_at, expires_at, resolved_at)
         VALUES (NEWID(), @event_id, @member_id, 'offered', GETUTCDATE(), DATEADD(hour, @offered_until_hours, GETUTCDATE()), NULL)`
      );

    const offerResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, eventId)
      .input('member_id', sql.UniqueIdentifier, candidate.member_id)
      .query<{ expires_at: Date }>(
        `SELECT TOP 1 expires_at
         FROM waitlist_promotion_offer
         WHERE event_id = @event_id AND member_id = @member_id
         ORDER BY offered_at DESC`
      );

    const expiresAt = offerResult.recordset[0]?.expires_at ?? new Date(Date.now() + 48 * 60 * 60 * 1000);

    await sendWaitlistPromotionNotification({
      event_id: event.event_id,
      title: event.title,
      event_date: event.event_date,
      location: event.location,
      description: event.description,
      member_id: candidate.member_id,
      preferredChannel: candidate.response_channel,
      recipientEmail: candidate.email,
      recipientPhone: candidate.mobile_phone,
      smsOptIn: candidate.sms_opt_in,
      emailOptOut: candidate.email_opt_out,
      expires_at: expiresAt,
    });

    availableSlots -= 1;
  }
}

export { VALID_RESPONSES, RsvpError, listPendingEventsForMember, recordRsvpResponse, triggerWaitlistAutoPromotion };
export type { PendingEvent, RecordedRsvp, RsvpResponse };