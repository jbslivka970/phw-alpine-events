import { Router } from 'express';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/rbac';
import { notificationService } from '../services/notifications';
import {
  inferResponseRoleForMember,
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

type InboundSource = 'direct' | 'event_grid' | 'tokenized';

router.get('/inbound/logs', apiLimiter, authenticate, requireAdmin, async (req, res) => {
  try {
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;

    const pool = await getPool();
    const queryRequest = pool
      .request()
      .input('limit', sql.Int, limit)
      .input('status', sql.NVarChar, status ?? null)
      .input('source', sql.NVarChar, source ?? null);

    const result = await queryRequest.query<{
      inbound_log_id: string;
      source: string;
      from_phone: string;
      normalized_phone: string | null;
      member_id: string | null;
      event_id: string | null;
      inbound_message: string;
      parsed_response: string | null;
      processing_status: string;
      response_message: string | null;
      error_detail: string | null;
      received_at: Date;
    }>(
      `SELECT TOP (@limit)
          inbound_log_id,
          source,
          from_phone,
          normalized_phone,
          member_id,
          event_id,
          inbound_message,
          parsed_response,
          processing_status,
          response_message,
          error_detail,
          received_at
       FROM dbo.inbound_sms_log
       WHERE (@status IS NULL OR processing_status = @status)
         AND (@source IS NULL OR source = @source)
       ORDER BY received_at DESC`
    );

    res.json({
      count: result.recordset.length,
      rows: result.recordset,
    });
  } catch (error) {
    console.error('GET /sms/inbound/logs failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/inbound', writeLimiter, async (req, res) => {
  try {
    if (isTokenizedRsvpPayload(req.body)) {
      const tokenPayload = req.body as { token: string; response?: string; response_role?: string };
      const token = verifyRsvpToken(tokenPayload.token);
      const tokenMessage = JSON.stringify({
        response: tokenPayload.response ?? null,
        response_role: tokenPayload.response_role ?? null,
      });

      if (typeof tokenPayload.response === 'string' && tokenPayload.response.trim().length > 0) {
        const response = tokenPayload.response.toLowerCase();
        const parsedResponseRole = parseResponseRole(tokenPayload.response_role);
        const inferredResponseRole = parsedResponseRole
          ? undefined
          : await inferResponseRoleForMember({
            memberId: token.memberId,
            groupContextId: token.groupContextId ?? null,
          });
        const responseRole = parsedResponseRole ?? inferredResponseRole;
        if (!VALID_RESPONSES.includes(response as RsvpResponse)) {
          const errorMessage = `response must be one of: ${VALID_RESPONSES.join(', ')}`;
          await writeInboundSmsLog({
            source: 'tokenized',
            fromPhone: 'tokenized',
            memberId: token.memberId,
            eventId: token.eventId,
            inboundMessage: tokenMessage,
            processingStatus: 'invalid_response',
            responseMessage: errorMessage,
          });
          res.status(400).json({ error: `response must be one of: ${VALID_RESPONSES.join(', ')}` });
          return;
        }

        if (tokenPayload.response_role !== undefined && !parsedResponseRole) {
          const errorMessage = 'response_role must be MENTOR or PARTICIPANT when provided';
          await writeInboundSmsLog({
            source: 'tokenized',
            fromPhone: 'tokenized',
            memberId: token.memberId,
            eventId: token.eventId,
            inboundMessage: tokenMessage,
            processingStatus: 'invalid_role',
            responseMessage: errorMessage,
          });
          res.status(400).json({ error: 'response_role must be MENTOR or PARTICIPANT when provided' });
          return;
        }

        if (requiresExplicitRole(response as RsvpResponse) && !responseRole) {
          const errorMessage = 'response_role is required for yes, maybe, and waitlist responses';
          await writeInboundSmsLog({
            source: 'tokenized',
            fromPhone: 'tokenized',
            memberId: token.memberId,
            eventId: token.eventId,
            inboundMessage: tokenMessage,
            processingStatus: 'role_required',
            responseMessage: errorMessage,
          });
          res.status(400).json({ error: 'response_role is required for yes, maybe, and waitlist responses' });
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

        await writeInboundSmsLog({
          source: 'tokenized',
          fromPhone: 'tokenized',
          memberId: token.memberId,
          eventId: token.eventId,
          inboundMessage: tokenMessage,
          parsedResponse: record.response,
          processingStatus: 'recorded',
        });

        res.json(record);
        return;
      }

      const context = await getTokenizedRsvpContext(token.eventId, token.memberId, token.groupContextId);
      if (!context) {
        res.status(404).json({ error: 'Event invite not found' });
        return;
      }

      res.json({
        ...context,
        token_expires_at: token.expiresAt ?? null,
      });

      await writeInboundSmsLog({
        source: 'tokenized',
        fromPhone: 'tokenized',
        memberId: token.memberId,
        eventId: token.eventId,
        inboundMessage: tokenMessage,
        processingStatus: 'context_served',
      });
      return;
    }

    const payload = extractInboundPayload(req.body, req.headers as Record<string, unknown>);

    if (payload.kind === 'validation') {
      res.json({ validationResponse: payload.validationCode });
      return;
    }

    if (payload.kind === 'batch') {
      const processed = [];
      for (const message of payload.messages) {
        processed.push(await processInboundMessage(message.from, message.message, 'event_grid'));
      }
      res.json({ processed });
      return;
    }

    const result = await processInboundMessage(payload.from, payload.message, 'direct');
    res.json(result);
  } catch (error) {
    console.error('POST /sms/inbound failed', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid inbound SMS payload' });
  }
});

async function processInboundMessage(from: string, rawMessage: string, source: InboundSource): Promise<Record<string, unknown>> {
  const normalizedFrom = toE164(from) ?? from;

  const logAndReturn = async (
    result: Record<string, unknown>,
    options: {
      memberId?: string;
      eventId?: string;
      parsedResponse?: string;
      errorDetail?: string;
    } = {}
  ): Promise<Record<string, unknown>> => {
    await writeInboundSmsLog({
      source,
      fromPhone: from,
      normalizedPhone: normalizedFrom,
      memberId: options.memberId,
      eventId: options.eventId,
      inboundMessage: rawMessage,
      parsedResponse: options.parsedResponse,
      processingStatus: String(result['status'] ?? 'unknown'),
      responseMessage: typeof result['reply'] === 'string' ? result['reply'] : undefined,
      errorDetail: options.errorDetail,
    });
    return result;
  };

  const member = await findMemberByPhone(from);
  if (!member) {
    return logAndReturn({
      status: 'ignored',
      from,
      reply: 'PHW Alpine: We could not match this phone number to a member profile. Contact chapter leadership for assistance.',
    });
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
    return logAndReturn(
      { status: 'opted_out', member_id: member.member_id, reply },
      { memberId: member.member_id }
    );
  }

  if (normalized === 'help') {
    const reply = "PHW Alpine: Y=yes, N=no, M=maybe, W=waitlist. If you have multiple invites, add the number: Y 1. If role is needed: Y V or Y P (V=volunteer, P=participant). Reply STOP to opt out.";
    await notificationService.sendSms({
      to: member.mobile_phone,
      message: reply,
      memberId: member.member_id,
      bypassOptInCheck: true,
    });
    return logAndReturn(
      { status: 'help_sent', member_id: member.member_id, reply },
      { memberId: member.member_id }
    );
  }

  const pendingEvents = await listPendingEventsForMember(member.member_id);
  const parsed = parseRsvpKeyword(normalized);
  if (!parsed) {
    const reply = pendingEvents.length > 1
      ? `PHW Alpine: Didn't understand. Reply Y, N, M, or W with the event number (e.g. Y 1). ${formatPendingEvents(pendingEvents)}`
      : "PHW Alpine: Didn't understand. Reply Y, N, M, or W. Reply HELP for instructions or STOP to opt out.";
    await notificationService.sendSms({
      to: member.mobile_phone,
      message: reply,
      memberId: member.member_id,
      bypassOptInCheck: true,
    });
    return logAndReturn(
      { status: 'unrecognized', member_id: member.member_id, reply },
      { memberId: member.member_id }
    );
  }

  if (pendingEvents.length === 0) {
    const reply = 'PHW Alpine: You do not have any open event invites awaiting RSVP right now.';
    await notificationService.sendSms({
      to: member.mobile_phone,
      message: reply,
      memberId: member.member_id,
      bypassOptInCheck: true,
    });
    return logAndReturn(
      { status: 'no_pending_events', member_id: member.member_id, reply },
      { memberId: member.member_id }
    );
  }

  const targetEvent = resolveTargetEvent(parsed.eventIndex, pendingEvents);
  if (!targetEvent) {
    const reply = buildAmbiguityReply(pendingEvents, parsed.eventIndex);
    await notificationService.sendSms({
      to: member.mobile_phone,
      message: reply,
      memberId: member.member_id,
      bypassOptInCheck: true,
    });
    return logAndReturn(
      { status: 'multiple_pending_events', member_id: member.member_id, reply },
      { memberId: member.member_id }
    );
  }

  try {
    const inferredResponseRole = parsed.responseRole ?? (await inferResponseRoleForMember({ memberId: member.member_id }));

    if (requiresExplicitRole(parsed.response) && !inferredResponseRole) {
      const reply = "PHW Alpine: Please include your role. Reply like 'Y V' or 'Y P' (V=volunteer, P=participant). Add event number if needed: Y V 1.";
      await notificationService.sendSms({
        to: member.mobile_phone,
        message: reply,
        memberId: member.member_id,
        bypassOptInCheck: true,
      });
      return logAndReturn(
        { status: 'role_required', member_id: member.member_id, reply },
        { memberId: member.member_id }
      );
    }

    const record = await recordRsvpResponse({
      eventId: targetEvent.event_id,
      memberId: member.member_id,
      response: parsed.response,
      notes: `SMS reply received: ${message}`,
      responseChannel: 'sms',
      responseRole: inferredResponseRole,
    });

    return logAndReturn(
      {
        status: 'recorded',
        member_id: member.member_id,
        event_id: targetEvent.event_id,
        response: record.response,
      },
      {
        memberId: member.member_id,
        eventId: targetEvent.event_id,
        parsedResponse: record.response,
      }
    );
  } catch (error) {
    if (error instanceof RsvpError) {
      const reply = `PHW Alpine: ${error.message}`;
      await notificationService.sendSms({
        to: member.mobile_phone,
        message: reply,
        memberId: member.member_id,
        bypassOptInCheck: true,
      });
      return logAndReturn(
        { status: 'error', member_id: member.member_id, reply },
        { memberId: member.member_id, errorDetail: error.message }
      );
    }

    throw error;
  }
}

async function writeInboundSmsLog(entry: {
  source: InboundSource;
  fromPhone: string;
  normalizedPhone?: string;
  memberId?: string;
  eventId?: string;
  inboundMessage: string;
  parsedResponse?: string;
  processingStatus: string;
  responseMessage?: string;
  errorDetail?: string;
}): Promise<void> {
  try {
    const pool = await getPool();
    await pool
      .request()
      .input('source', sql.NVarChar, entry.source)
      .input('from_phone', sql.NVarChar, entry.fromPhone)
      .input('normalized_phone', sql.NVarChar, entry.normalizedPhone ?? null)
      .input('member_id', sql.UniqueIdentifier, entry.memberId ?? null)
      .input('event_id', sql.UniqueIdentifier, entry.eventId ?? null)
      .input('inbound_message', sql.NVarChar, entry.inboundMessage)
      .input('parsed_response', sql.NVarChar, entry.parsedResponse ?? null)
      .input('processing_status', sql.NVarChar, entry.processingStatus)
      .input('response_message', sql.NVarChar, entry.responseMessage ?? null)
      .input('error_detail', sql.NVarChar, entry.errorDetail ?? null)
      .query(
        `INSERT INTO dbo.inbound_sms_log
          (inbound_log_id, source, from_phone, normalized_phone, member_id, event_id, inbound_message, parsed_response, processing_status, response_message, error_detail, received_at)
         VALUES
          (NEWID(), @source, @from_phone, @normalized_phone, @member_id, @event_id, @inbound_message, @parsed_response, @processing_status, @response_message, @error_detail, GETUTCDATE())`
      );
  } catch (error) {
    // Non-blocking: inbound processing should continue even if audit logging fails.
    console.warn('[sms] failed to write inbound_sms_log', error);
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

function parseRsvpKeyword(message: string): { response: RsvpResponse; responseRole?: 'MENTOR' | 'PARTICIPANT'; eventIndex?: number } | null {
  const tokens = message.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 3) {
    return null;
  }

  let response: RsvpResponse | undefined;
  let responseRole: 'MENTOR' | 'PARTICIPANT' | undefined;
  let eventIndex: number | undefined;

  for (const token of tokens) {
    if (!response && RESPONSE_MAP[token]) {
      response = RESPONSE_MAP[token];
      continue;
    }

    const parsedRole = parseResponseRole(token);
    if (!responseRole && parsedRole) {
      responseRole = parsedRole;
      continue;
    }

    if (!eventIndex && /^\d+$/.test(token)) {
      const parsedIndex = parseInt(token, 10);
      if (!Number.isNaN(parsedIndex)) {
        eventIndex = parsedIndex;
        continue;
      }
    }

    return null;
  }

  if (!response) {
    return null;
  }

  return {
    response,
    responseRole,
    eventIndex,
  };
}

function parseResponseRole(value: unknown): 'MENTOR' | 'PARTICIPANT' | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  if (normalized === 'MENTOR' || normalized === 'VOLUNTEER' || normalized === 'V') {
    return 'MENTOR';
  }
  if (normalized === 'PARTICIPANT' || normalized === 'P') {
    return 'PARTICIPANT';
  }

  return undefined;
}

function requiresExplicitRole(response: RsvpResponse): boolean {
  return response === 'yes' || response === 'maybe' || response === 'waitlist';
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

function buildAmbiguityReply(pendingEvents: PendingEvent[], attemptedIndex?: number): string {
  const eventList = formatPendingEvents(pendingEvents);

  if (attemptedIndex !== undefined && (attemptedIndex < 1 || attemptedIndex > pendingEvents.length)) {
    return `PHW Alpine: That event number is out of range. Reply with Y, N, M, or W and a number (e.g. Y 1). ${eventList}`;
  }

  return `PHW Alpine: You have multiple open invites. Reply with Y, N, M, or W and the event number (e.g. Y 1). ${eventList}`;
}

function formatPendingEvents(pendingEvents: PendingEvent[]): string {
  return pendingEvents
    .slice(0, 3)
    .map((event, index) => `${index + 1}) ${event.title}`)
    .join(' ');
}

function isTokenizedRsvpPayload(body: unknown): boolean {
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    return false;
  }

  const token = (body as Record<string, unknown>).token;
  return typeof token === 'string' && token.length > 0;
}

async function getTokenizedRsvpContext(eventId: string, memberId: string, groupContextId?: string): Promise<{
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
  inferred_response_role: 'MENTOR' | 'PARTICIPANT' | null;
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

  const context = result.recordset[0] ?? null;
  if (!context) {
    return null;
  }

  return {
    ...context,
    inferred_response_role: (await inferResponseRoleForMember({ memberId, groupContextId: groupContextId ?? null })) ?? null,
  };
}

function getToken(query: Record<string, unknown>): string {
  const queryToken = query.token;
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }

  throw new Error('token is required');
}

function extractInboundPayload(body: unknown, headers: Record<string, unknown> = {}):
  | { kind: 'single'; from: string; message: string }
  | { kind: 'batch'; messages: Array<{ from: string; message: string }> }
  | { kind: 'validation'; validationCode: string } {
  const eventTypeHeader = getHeaderValue(headers, 'aeg-event-type');

  if (eventTypeHeader === 'SubscriptionValidation') {
    const record = body as Record<string, unknown> | null;
    const validationCode = readString(record?.['data'], 'validationCode');
    if (!validationCode) {
      throw new Error('Missing validation code.');
    }
    return { kind: 'validation', validationCode };
  }

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
      .map((entry) => extractEventGridMessage((entry as Record<string, unknown>)?.data))
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

  const telnyxMessage = extractTelnyxMessage(record);
  if (telnyxMessage) {
    return { kind: 'single', from: telnyxMessage.from, message: telnyxMessage.message };
  }

  if (eventTypeHeader === 'Notification' && (record['eventType'] || record['data'])) {
    const eventGridMessage = extractEventGridMessage(record['data']);
    if (!eventGridMessage.from || !eventGridMessage.message) {
      throw new Error('No SMS messages found in batch payload.');
    }
    return { kind: 'batch', messages: [eventGridMessage] };
  }

  const from = String(record.from ?? '');
  const message = String(record.message ?? record.messageBody ?? '');
  if (!from || !message) {
    throw new Error('from and message are required.');
  }

  return { kind: 'single', from, message };
}

function extractTelnyxMessage(record: Record<string, unknown>): { from: string; message: string } | null {
  const payload = (record['data'] as Record<string, unknown> | undefined)?.['payload'] as Record<string, unknown> | undefined;
  if (!payload) {
    return null;
  }

  const from = readNestedString(payload, ['from', 'phone_number'])
    ?? readString(payload, 'from')
    ?? '';
  const message = readString(payload, 'text')
    ?? readString(payload, 'body')
    ?? '';

  const normalizedFrom = from.trim();
  const normalizedMessage = message.trim();
  if (!normalizedFrom || !normalizedMessage) {
    return null;
  }

  return {
    from: normalizedFrom,
    message: normalizedMessage,
  };
}

function extractEventGridMessage(data: unknown): { from: string; message: string } {
  const from = readString(data, 'from')
    ?? readString(data, 'fromPhoneNumber')
    ?? readNestedString(data, ['from', 'phoneNumber', 'value'])
    ?? '';

  const message = readString(data, 'message')
    ?? readString(data, 'messageBody')
    ?? readString(data, 'text')
    ?? readString(data, 'body')
    ?? '';

  return {
    from: from.trim(),
    message: message.trim(),
  };
}

function readString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') {
    return undefined;
  }

  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function readNestedString(input: unknown, path: string[]): string | undefined {
  let current: unknown = input;
  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === 'string' ? current : undefined;
}

function getHeaderValue(headers: Record<string, unknown>, key: string): string | undefined {
  const candidate = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
  if (typeof candidate === 'string') {
    return candidate;
  }
  if (Array.isArray(candidate) && typeof candidate[0] === 'string') {
    return candidate[0];
  }
  return undefined;
}

export default router;