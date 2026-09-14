import { Router, type Request } from 'express';
import { createPublicKey, verify as verifySignature } from 'node:crypto';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { DEFAULT_TENANT_ID } from '../middleware/resolveTenantContext';
import { apiLimiter, publicLimiter } from '../middleware/rateLimiter';
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

declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

const TELNYX_SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

function telnyxPublicKey(): ReturnType<typeof createPublicKey> | null {
  const configured = process.env['TELNYX_WEBHOOK_PUBLIC_KEY']?.trim();
  if (!configured) {
    return null;
  }
  if (configured.includes('BEGIN PUBLIC KEY')) {
    return createPublicKey(configured.replace(/\\n/g, '\n'));
  }
  const rawKey = Buffer.from(configured, 'base64');
  if (rawKey.length !== 32) {
    throw new Error('TELNYX_WEBHOOK_PUBLIC_KEY must be a PEM or base64 Ed25519 public key.');
  }
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  return createPublicKey({ key: Buffer.concat([spkiPrefix, rawKey]), format: 'der', type: 'spki' });
}

function verifyTelnyxWebhook(req: Request): boolean {
  const signature = typeof req.headers['telnyx-signature-ed25519'] === 'string'
    ? req.headers['telnyx-signature-ed25519'].trim()
    : '';
  const timestamp = typeof req.headers['telnyx-timestamp'] === 'string'
    ? req.headers['telnyx-timestamp'].trim()
    : '';
  const timestampSeconds = Number.parseInt(timestamp, 10);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!signature || !Number.isFinite(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > TELNYX_SIGNATURE_MAX_AGE_SECONDS) {
    return false;
  }
  const publicKey = telnyxPublicKey();
  if (!publicKey || !req.rawBody) {
    return false;
  }
  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}|`), req.rawBody]);
  try {
    return verifySignature(null, signedPayload, publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

function isTelnyxPayload(body: unknown): boolean {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : null;
  const data = record?.['data'];
  return Boolean(data && typeof data === 'object' && (data as Record<string, unknown>)['payload']);
}

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

type InboundProviderContext = {
  tenantId: string;
  destination: string;
  providerEventId: string;
};

type SmsTenantSupport = {
  hasMemberTenantTable: boolean;
  hasEventTenantColumn: boolean;
};

let cachedSmsTenantSupport: SmsTenantSupport | null = null;

function isMultiTenantEnabled(): boolean {
  const raw = process.env['MULTI_TENANT_ENABLED'];
  if (!raw) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

async function getSmsTenantSupport(pool: Awaited<ReturnType<typeof getPool>>): Promise<SmsTenantSupport> {
  if (cachedSmsTenantSupport) {
    return cachedSmsTenantSupport;
  }

  const result = await pool
    .request()
    .query<{ has_member_tenant_table: number; has_event_tenant_column: number }>(
      `SELECT
          CASE WHEN OBJECT_ID('dbo.member_tenant', 'U') IS NULL THEN 0 ELSE 1 END AS has_member_tenant_table,
          CASE WHEN COL_LENGTH('dbo.event', 'tenant_id') IS NULL THEN 0 ELSE 1 END AS has_event_tenant_column`
    );

  cachedSmsTenantSupport = {
    hasMemberTenantTable: result.recordset[0]?.has_member_tenant_table === 1,
    hasEventTenantColumn: result.recordset[0]?.has_event_tenant_column === 1,
  };

  return cachedSmsTenantSupport;
}

router.get('/inbound/logs', apiLimiter, authenticate, requireAdmin, async (req, res) => {
  try {
    const limitRaw = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : 100;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 100;

    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;

    const pool = await getPool();
    const tenantId = (req.tenantId ?? DEFAULT_TENANT_ID).trim().toLowerCase();
    const tenantSupport = isMultiTenantEnabled() ? await getSmsTenantSupport(pool) : { hasMemberTenantTable: false, hasEventTenantColumn: false };
    const applyTenantScope = tenantSupport.hasMemberTenantTable || tenantSupport.hasEventTenantColumn;
    const tenantPredicates: string[] = [];

    if (tenantSupport.hasMemberTenantTable) {
      tenantPredicates.push(`EXISTS (
           SELECT 1
           FROM dbo.member_tenant mt
           WHERE mt.member_id = log.member_id
             AND mt.tenant_id = @tenant_id
             AND mt.is_active = 1
         )`);
    }

    if (tenantSupport.hasEventTenantColumn) {
      tenantPredicates.push(`EXISTS (
           SELECT 1
           FROM dbo.event e
           WHERE e.event_id = log.event_id
             AND e.tenant_id = @tenant_id
         )`);
    }

    const tenantFilter = applyTenantScope
      ? `
         AND (
           ${tenantPredicates.join('\n           OR ')}
         )`
      : '';

    const queryRequest = pool
      .request()
      .input('limit', sql.Int, limit)
      .input('status', sql.NVarChar, status ?? null)
      .input('source', sql.NVarChar, source ?? null);

    if (applyTenantScope) {
      queryRequest.input('tenant_id', sql.UniqueIdentifier, tenantId);
    }

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
       FROM dbo.inbound_sms_log log
       WHERE (@status IS NULL OR processing_status = @status)
         AND (@source IS NULL OR source = @source)
         ${tenantFilter}
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

router.post('/inbound', publicLimiter, async (req, res) => {
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

    const eventTypeHeader = getHeaderValue(req.headers as Record<string, unknown>, 'aeg-event-type');
    const isEventGridValidation = eventTypeHeader === 'SubscriptionValidation'
      || (Array.isArray(req.body) && (req.body[0] as Record<string, unknown> | undefined)?.eventType === 'Microsoft.EventGrid.SubscriptionValidationEvent');
    if (process.env['NODE_ENV'] === 'production' && !isEventGridValidation) {
      if (!isTelnyxPayload(req.body) || !verifyTelnyxWebhook(req)) {
        res.status(401).json({ error: 'Invalid inbound SMS webhook signature.' });
        return;
      }
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

    if (payload.provider === 'telnyx' && payload.direction === 'outbound') {
      res.status(200).json({ status: 'ignored', reason: 'outbound_provider_event' });
      return;
    }

    let providerContext: InboundProviderContext | undefined;
    if (payload.provider === 'telnyx') {
      if (!payload.destination || !payload.providerEventId) {
        if (process.env['NODE_ENV'] === 'production') {
          res.status(400).json({ error: 'Telnyx event id and destination are required.' });
          return;
        }
      } else {
        const tenantId = await resolveSmsTenant(payload.destination);
        if (!tenantId) {
          res.status(400).json({ error: 'Inbound SMS destination does not resolve to exactly one active tenant.' });
          return;
        }

        const claimed = await claimWebhookReceipt('telnyx', payload.providerEventId);
        if (!claimed) {
          res.status(200).json({ status: 'duplicate', provider_event_id: payload.providerEventId });
          return;
        }

        providerContext = {
          tenantId,
          destination: payload.destination,
          providerEventId: payload.providerEventId,
        };
      }
    }

    const result = await processInboundMessage(payload.from, payload.message, 'direct', providerContext);
    res.json(result);
  } catch (error) {
    console.error('POST /sms/inbound failed', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid inbound SMS payload' });
  }
});

async function processInboundMessage(
  from: string,
  rawMessage: string,
  source: InboundSource,
  providerContext?: InboundProviderContext
): Promise<Record<string, unknown>> {
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
      tenantId: providerContext?.tenantId,
      destination: providerContext?.destination,
      providerEventId: providerContext?.providerEventId,
    });
    return result;
  };

  const member = await findMemberByPhone(from, providerContext?.tenantId);
  if (!member) {
    return logAndReturn({
      status: 'ignored',
      from,
      reply: 'PHW Alpine: We could not match this phone number to a member profile. Contact program leadership for assistance.',
    });
  }

  const message = rawMessage.trim();
  const normalized = message.toLowerCase().replace(/\s+/g, ' ');
  const smokeTestMatch = normalized.match(/^phw scheduler smoke test commit ([a-z0-9._-]+)$/i);

  if (smokeTestMatch) {
    const commitRef = smokeTestMatch[1];
    const reply = `PHW Alpine: Scheduler smoke test recorded for commit ${commitRef}.`;
    await notificationService.sendSms({
      to: member.mobile_phone,
      message: reply,
      tenantId: providerContext?.tenantId,
      memberId: member.member_id,
      bypassOptInCheck: true,
    });
    return logAndReturn(
      { status: 'smoke_test_ack', member_id: member.member_id, reply },
      { memberId: member.member_id, parsedResponse: `smoke:${commitRef}` }
    );
  }

  if (normalized === 'stop') {
    await optOutMember(member.member_id, providerContext?.tenantId);
    const reply = 'PHW Alpine: You have been unsubscribed from text notifications. Use the preferences page in the app to opt back in later.';
    await notificationService.sendSms({
      to: member.mobile_phone,
      message: reply,
      tenantId: providerContext?.tenantId,
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
      tenantId: providerContext?.tenantId,
      memberId: member.member_id,
      bypassOptInCheck: true,
    });
    return logAndReturn(
      { status: 'help_sent', member_id: member.member_id, reply },
      { memberId: member.member_id }
    );
  }

  const pendingEvents = await listPendingEventsForMember(member.member_id, providerContext?.tenantId);
  const parsed = parseRsvpKeyword(normalized);
  if (!parsed) {
    const reply = pendingEvents.length > 1
      ? `PHW Alpine: Didn't understand. Reply Y, N, M, or W with the event number (e.g. Y 1). ${formatPendingEvents(pendingEvents)}`
      : "PHW Alpine: Didn't understand. Reply Y, N, M, or W. Reply HELP for instructions or STOP to opt out.";
    await notificationService.sendSms({
      to: member.mobile_phone,
      message: reply,
      tenantId: providerContext?.tenantId,
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
      tenantId: providerContext?.tenantId,
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
      tenantId: providerContext?.tenantId,
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
      const actionToken = responseToSmsToken(parsed.response);
      const roleExamples = parsed.eventIndex !== undefined
        ? `${actionToken} V ${parsed.eventIndex} or ${actionToken} P ${parsed.eventIndex}`
        : `${actionToken} V or ${actionToken} P`;
      const reply = `PHW Alpine: Thanks, we still need your role for ${targetEvent.title}. Reply ${roleExamples} (V=volunteer, P=participant).`;
      await notificationService.sendSms({
        to: member.mobile_phone,
        message: reply,
        tenantId: providerContext?.tenantId,
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
      tenantId: providerContext?.tenantId,
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
        tenantId: providerContext?.tenantId,
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
  tenantId?: string;
  destination?: string;
  providerEventId?: string;
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
      .input('tenant_id', sql.UniqueIdentifier, entry.tenantId ?? null)
      .input('destination', sql.NVarChar, entry.destination ?? null)
      .input('provider_event_id', sql.NVarChar, entry.providerEventId ?? null)
      .query(
        `INSERT INTO dbo.inbound_sms_log
          (inbound_log_id, source, from_phone, normalized_phone, member_id, event_id, inbound_message, parsed_response, processing_status, response_message, error_detail, tenant_id, destination, provider_event_id, received_at)
         VALUES
          (NEWID(), @source, @from_phone, @normalized_phone, @member_id, @event_id, @inbound_message, @parsed_response, @processing_status, @response_message, @error_detail, @tenant_id, @destination, @provider_event_id, GETUTCDATE())`
      );
  } catch (error) {
    // Non-blocking: inbound processing should continue even if audit logging fails.
    console.warn('[sms] failed to write inbound_sms_log', error);
  }
}

async function findMemberByPhone(from: string, tenantId?: string): Promise<{ member_id: string; mobile_phone: string } | null> {
  const normalizedPhone = toE164(from);
  if (!normalizedPhone) {
    return null;
  }

  const pool = await getPool();
  const result = await pool
    .request()
    .input('mobile_phone', sql.NVarChar, normalizedPhone)
    .input('tenant_id', sql.UniqueIdentifier, tenantId ?? null)
    .query<{ member_id: string; mobile_phone: string }>(
      `SELECT TOP 1 member_id, mobile_phone
       FROM member m
       WHERE m.mobile_phone = @mobile_phone
         AND m.is_active = 1
         AND (@tenant_id IS NULL OR EXISTS (
           SELECT 1
           FROM dbo.tenant_membership tm
           WHERE tm.member_id = m.member_id
             AND tm.tenant_id = @tenant_id
             AND tm.status = 'active'
             AND tm.revoked_at IS NULL
             AND tm.starts_at <= GETUTCDATE()
             AND (tm.expires_at IS NULL OR tm.expires_at > GETUTCDATE())
         ))`
    );

  return result.recordset[0] ?? null;
}

async function optOutMember(memberId: string, tenantId?: string): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('tenant_id', sql.UniqueIdentifier, tenantId ?? null)
    .query(
      `UPDATE member
       SET sms_opt_in = 0,
           sms_opt_out_date = GETUTCDATE(),
           updated_at = GETUTCDATE()
       WHERE member_id = @member_id
         AND (@tenant_id IS NULL OR EXISTS (
           SELECT 1 FROM dbo.tenant_membership tm
           WHERE tm.member_id = member.member_id
             AND tm.tenant_id = @tenant_id
             AND tm.status = 'active'
             AND tm.revoked_at IS NULL
             AND tm.starts_at <= GETUTCDATE()
             AND (tm.expires_at IS NULL OR tm.expires_at > GETUTCDATE())
         ))`
    );

  await notificationService.writeSmsConsentLog(memberId, 'opt_out', 'reply', 'Inbound STOP message', tenantId);
}

async function resolveSmsTenant(destination: string): Promise<string | null> {
  const normalizedDestination = toE164(destination);
  if (!normalizedDestination) {
    return null;
  }

  const pool = await getPool();
  const result = await pool.request().query<{ tenant_id: string; telnyx_from_number: string | null; sms_from: string | null }>(
    `SELECT tm.tenant_id, tm.telnyx_from_number, tm.sms_from
     FROM dbo.tenant_messaging tm
     INNER JOIN dbo.tenant t ON t.tenant_id = tm.tenant_id
     WHERE t.status = 'active'
       AND tm.sms_enabled = 1
       AND (tm.telnyx_from_number IS NOT NULL OR tm.sms_from IS NOT NULL)`
  );

  const matches = result.recordset.filter((row) =>
    toE164(row.telnyx_from_number ?? '') === normalizedDestination
    || toE164(row.sms_from ?? '') === normalizedDestination
  );
  return matches.length === 1 ? matches[0].tenant_id : null;
}

async function claimWebhookReceipt(provider: string, eventId: string): Promise<boolean> {
  try {
    const pool = await getPool();
    await pool
      .request()
      .input('provider', sql.NVarChar, provider)
      .input('event_id', sql.NVarChar, eventId)
      .query(
        `INSERT INTO dbo.webhook_receipt (webhook_receipt_id, provider, event_id, received_at, expires_at)
         VALUES (NEWID(), @provider, @event_id, SYSUTCDATETIME(), DATEADD(day, 7, SYSUTCDATETIME()))`
      );
    return true;
  } catch (error) {
    const number = (error as { number?: number }).number;
    if (number === 2601 || number === 2627) {
      return false;
    }
    throw error;
  }
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

function responseToSmsToken(response: RsvpResponse): 'Y' | 'M' | 'W' {
  if (response === 'maybe') {
    return 'M';
  }
  if (response === 'waitlist') {
    return 'W';
  }
  return 'Y';
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
  | { kind: 'single'; from: string; message: string; provider?: 'telnyx'; destination?: string; providerEventId?: string; direction?: string }
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
    return { kind: 'single', provider: 'telnyx', ...telnyxMessage };
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

function extractTelnyxMessage(record: Record<string, unknown>): {
  from: string;
  message: string;
  destination?: string;
  providerEventId?: string;
  direction?: string;
} | null {
  const data = record['data'] as Record<string, unknown> | undefined;
  const payload = data?.['payload'] as Record<string, unknown> | undefined;
  if (!payload) {
    return null;
  }

  const from = readNestedString(payload, ['from', 'phone_number'])
    ?? readString(payload, 'from')
    ?? '';
  const message = readString(payload, 'text')
    ?? readString(payload, 'body')
    ?? '';
  const destination = (
    readNestedString(payload, ['to', 'phone_number'])
    ?? (Array.isArray(payload['to']) ? readNestedString(payload['to'][0], ['phone_number']) : undefined)
  )?.trim();
  const providerEventId = readString(data, 'id')?.trim();
  const direction = readString(payload, 'direction')?.trim();

  const normalizedFrom = from.trim();
  const normalizedMessage = message.trim();
  if (!normalizedFrom || !normalizedMessage) {
    return null;
  }

  return {
    from: normalizedFrom,
    message: normalizedMessage,
    destination: destination || undefined,
    providerEventId: providerEventId || undefined,
    direction: direction || undefined,
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