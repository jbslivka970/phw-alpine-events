import { Router } from 'express';
import { getPool, sql } from '../db';
import { writeLimiter } from '../middleware/rateLimiter';
import { notificationService } from '../services/notifications';
import {
  VALID_RESPONSES,
  listPendingEventsForMember,
  recordRsvpResponse,
  RsvpError,
  type PendingEvent,
  type RsvpResponse,
} from '../services/rsvpService';
import { verifyRsvpToken } from '../services/rsvpLinkService';
import { toE164 } from '../utils/phone';

const router = Router();

const RESPONSE_MAP: Record<string, RsvpResponse> = {
  y: 'yes',
  yes: 'yes',
  n: 'no',
  no: 'no',
  m: 'maybe',
  maybe: 'maybe',
  w: 'waitlist',
  waitlist: 'waitlist',
};

router.post('/inbound', writeLimiter, async (req, res) => {
  try {
    if (isTokenizedRsvpPayload(req.body)) {
      const tokenPayload = req.body as { token: string; response?: string };
      const token = verifyRsvpToken(tokenPayload.token);

      if (typeof tokenPayload.response === 'string' && tokenPayload.response.trim().length > 0) {
        const response = tokenPayload.response.toLowerCase();
        if (!VALID_RESPONSES.includes(response as RsvpResponse)) {
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
        return;
      }

      const context = await getTokenizedRsvpContext(token.eventId, token.memberId);
      if (!context) {
        res.status(404).json({ error: 'Event invite not found' });
        return;
      }

      res.json({
        ...context,
        token_expires_at: token.expiresAt ?? null,
      });
      return;
    }

    const payload = extractInboundPayload(req.body);

    if (payload.kind === 'validation') {
      res.json({ validationResponse: payload.validationCode });
      return;
    }

    if (payload.kind === 'batch') {
      const processed = [];
      for (const message of payload.messages) {
        processed.push(await processInboundMessage(message.from, message.message));
      }
      res.json({ processed });
      return;
    }

    const result = await processInboundMessage(payload.from, payload.message);
    res.json(result);
  } catch (error) {
    console.error('POST /sms/inbound failed', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid inbound SMS payload' });
  }
});

async function processInboundMessage(from: string, rawMessage: string): Promise<Record<string, unknown>> {
  const member = await findMemberByPhone(from);
  if (!member) {
    return {
      status: 'ignored',
      from,
      reply: 'PHW Alpine: We could not match this phone number to a member profile. Contact chapter leadership for assistance.',
    };
  }

  const message = rawMessage.trim();
  const normalized = message.toLowerCase().replace(/\s+/g, ' ');

  if (normalized === 'stop') {
    await optOutMember(member.member_id);
    const reply = 'PHW Alpine: You have been unsubscribed from text notifications. Use the preferences page in the app to opt back in later.';
    await notificationService.sendSms({
      to: member.mobile_phone,
      message: reply,
      memberId: member.member_id,
      bypassOptInCheck: true,
    });
    return { status: 'opted_out', member_id: member.member_id, reply };
  }

  if (normalized === 'help') {
    const reply = 'PHW Alpine: Reply Y, N, M, or W to event texts. Reply STOP to opt out. For more help, contact chapter leadership.';
    await notificationService.sendSms({
      to: member.mobile_phone,
      message: reply,
      memberId: member.member_id,
      bypassOptInCheck: true,
    });
    return { status: 'help_sent', member_id: member.member_id, reply };
  }

  const parsed = parseRsvpKeyword(normalized);
  if (!parsed) {
    const reply = "PHW Alpine: Didn't understand. Reply Y, N, M, or W. If you have multiple invites, reply like 'Y 1'. Reply STOP to opt out.";
    await notificationService.sendSms({
      to: member.mobile_phone,
      message: reply,
      memberId: member.member_id,
      bypassOptInCheck: true,
    });
    return { status: 'unrecognized', member_id: member.member_id, reply };
  }

  const pendingEvents = await listPendingEventsForMember(member.member_id);
  if (pendingEvents.length === 0) {
    const reply = 'PHW Alpine: You do not have any open event invites awaiting RSVP right now.';
    await notificationService.sendSms({
      to: member.mobile_phone,
      message: reply,
      memberId: member.member_id,
      bypassOptInCheck: true,
    });
    return { status: 'no_pending_events', member_id: member.member_id, reply };
  }

  const targetEvent = resolveTargetEvent(parsed.eventIndex, pendingEvents);
  if (!targetEvent) {
    const reply = buildAmbiguityReply(pendingEvents);
    await notificationService.sendSms({
      to: member.mobile_phone,
      message: reply,
      memberId: member.member_id,
      bypassOptInCheck: true,
    });
    return { status: 'multiple_pending_events', member_id: member.member_id, reply };
  }

  try {
    const record = await recordRsvpResponse({
      eventId: targetEvent.event_id,
      memberId: member.member_id,
      response: parsed.response,
      notes: `SMS reply received: ${message}`,
      responseChannel: 'sms',
    });

    return {
      status: 'recorded',
      member_id: member.member_id,
      event_id: targetEvent.event_id,
      response: record.response,
    };
  } catch (error) {
    if (error instanceof RsvpError) {
      const reply = `PHW Alpine: ${error.message}`;
      await notificationService.sendSms({
        to: member.mobile_phone,
        message: reply,
        memberId: member.member_id,
        bypassOptInCheck: true,
      });
      return { status: 'error', member_id: member.member_id, reply };
    }

    throw error;
  }
}

async function findMemberByPhone(from: string): Promise<{ member_id: string; mobile_phone: string } | null> {
  const normalizedPhone = toE164(from);
  if (!normalizedPhone) {
    return null;
  }

  const pool = await getPool();
  const result = await pool
    .request()
    .input('mobile_phone', sql.NVarChar, normalizedPhone)
    .query<{ member_id: string; mobile_phone: string }>(
      `SELECT TOP 1 member_id, mobile_phone
       FROM member
       WHERE mobile_phone = @mobile_phone
         AND is_active = 1`
    );

  return result.recordset[0] ?? null;
}

async function optOutMember(memberId: string): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query(
      `UPDATE member
       SET sms_opt_in = 0,
           sms_opt_out_date = GETUTCDATE(),
           updated_at = GETUTCDATE()
       WHERE member_id = @member_id`
    );

  await notificationService.writeSmsConsentLog(memberId, 'opt_out', 'reply', 'Inbound STOP message');
}

function parseRsvpKeyword(message: string): { response: RsvpResponse; eventIndex?: number } | null {
  const match = /^(y|yes|n|no|m|maybe|w|waitlist)(?:\s+(\d+))?$/.exec(message);
  if (!match) {
    return null;
  }

  const response = RESPONSE_MAP[match[1]];
  const eventIndex = match[2] ? parseInt(match[2], 10) : undefined;
  return { response, eventIndex: eventIndex && !Number.isNaN(eventIndex) ? eventIndex : undefined };
}

function resolveTargetEvent(eventIndex: number | undefined, pendingEvents: PendingEvent[]): PendingEvent | null {
  if (eventIndex !== undefined) {
    return pendingEvents[eventIndex - 1] ?? null;
  }

  if (pendingEvents.length === 1) {
    return pendingEvents[0];
  }

  return null;
}

function buildAmbiguityReply(pendingEvents: PendingEvent[]): string {
  const eventList = pendingEvents
    .slice(0, 3)
    .map((event, index) => `${index + 1}) ${event.title}`)
    .join(' ');
  return `PHW Alpine: You have multiple open invites. Reply like 'Y 1', 'N 1', 'M 1', or 'W 1'. ${eventList}`;
}

function isTokenizedRsvpPayload(body: unknown): boolean {
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    return false;
  }

  const token = (body as Record<string, unknown>).token;
  return typeof token === 'string' && token.length > 0;
}

async function getTokenizedRsvpContext(eventId: string, memberId: string): Promise<{
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
} | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .input('member_id', sql.UniqueIdentifier, memberId)
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

  return result.recordset[0] ?? null;
}

function getToken(query: Record<string, unknown>): string {
  const queryToken = query.token;
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }

  throw new Error('token is required');
}

function extractInboundPayload(body: unknown):
  | { kind: 'single'; from: string; message: string }
  | { kind: 'batch'; messages: Array<{ from: string; message: string }> }
  | { kind: 'validation'; validationCode: string } {
  if (Array.isArray(body)) {
    const first = body[0] as Record<string, unknown> | undefined;
    if (first?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent') {
      const validationCode = String((first.data as Record<string, unknown>)?.validationCode ?? '');
      if (!validationCode) {
        throw new Error('Missing validation code.');
      }
      return { kind: 'validation', validationCode };
    }

    const messages = body
      .map((entry) => {
        const record = entry as Record<string, unknown>;
        const data = (record.data ?? {}) as Record<string, unknown>;
        return {
          from: String(data.from ?? ''),
          message: String(data.message ?? data.messageBody ?? ''),
        };
      })
      .filter((entry) => entry.from && entry.message);

    if (messages.length === 0) {
      throw new Error('No SMS messages found in batch payload.');
    }

    return { kind: 'batch', messages };
  }

  const record = body as Record<string, unknown> | null;
  if (!record) {
    throw new Error('Request body is required.');
  }

  const from = String(record.from ?? '');
  const message = String(record.message ?? record.messageBody ?? '');
  if (!from || !message) {
    throw new Error('from and message are required.');
  }

  return { kind: 'single', from, message };
}

export default router;