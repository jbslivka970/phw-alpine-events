import { Router, type Request, type Response } from 'express';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAnyAuthenticatedRole, requireEventCreatorOrAdmin } from '../middleware/rbac';
import rsvpRouter from './rsvp';
import {
  assertEventCancelledNotificationReady,
  assertEventPublishedNotificationReady,
  assertEventUpdatedNotificationReady,
  notificationService,
  sendAssignmentConfirmation,
  sendEventCancelledNotification,
  sendEventCompletedNotification,
  sendEventPublishedNotification,
  sendEventRsvpReminderToNonResponders,
  sendEventUpdatedNotification,
} from '../services/notifications';
import { inferResponseRoleForMember, recordRsvpResponse, RsvpError, VALID_RESPONSES, type RsvpResponse } from '../services/rsvpService';
import { resolveShortRsvpToken, verifyRsvpToken } from '../services/rsvpLinkService';
import { generateDescriptionDraft, generateInviteDraft } from '../services/aiInviteService';
import { getEventEmailWorkflowSettings, upsertEventEmailWorkflowSettings } from '../services/eventEmailWorkflowService';
import { sendPostEventParticipationSummaryEmail, sendPreEventLeadSummaryEmail } from '../services/eventSummaryEmailService';
import { invalidateShortLivedCache, withShortLivedCache } from '../services/shortLivedCache';
import { formatInProgramTimeZone } from '../utils/dateTime';

const router = Router();

const STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['published', 'cancelled'],
  published: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

type EventColumnSupport = {
  hasPhotoUrl: boolean;
  hasInvitationStage: boolean;
};

type LeadSecondaryRole = 'MENTOR' | 'PARTICIPANT';

class HttpError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = 'HttpError';
  }
}

let cachedEventColumnSupport: EventColumnSupport | null = null;

async function getEventColumnSupport(pool: Awaited<ReturnType<typeof getPool>>): Promise<EventColumnSupport> {
  if (cachedEventColumnSupport) {
    return cachedEventColumnSupport;
  }

  const result = await pool
    .request()
    .query<{ has_photo_url: number; has_invitation_stage: number }>(
      `SELECT
         CASE WHEN COL_LENGTH('dbo.event', 'photo_url') IS NULL THEN 0 ELSE 1 END AS has_photo_url,
         CASE WHEN COL_LENGTH('dbo.event', 'invitation_stage') IS NULL THEN 0 ELSE 1 END AS has_invitation_stage`
    );

  const row = result.recordset[0];
  cachedEventColumnSupport = {
    hasPhotoUrl: row?.has_photo_url === 1,
    hasInvitationStage: row?.has_invitation_stage === 1,
  };

  return cachedEventColumnSupport;
}

// Derived projections that overlay event.event_lead_member_id with member name/email.
// Used as drop-in replacements for legacy event_lead_name/event_lead_email column reads.
const EVENT_LEAD_NAME_SELECT = `(SELECT TOP 1 LTRIM(RTRIM(ISNULL(lm.first_name, N'') + N' ' + ISNULL(lm.last_name, N''))) FROM dbo.member lm WHERE lm.member_id = event_lead_member_id) AS event_lead_name`;
const EVENT_LEAD_EMAIL_SELECT = `(SELECT TOP 1 lm.email FROM dbo.member lm WHERE lm.member_id = event_lead_member_id) AS event_lead_email`;

function isNotificationConfigurationError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'NotificationConfigurationError';
}

type AiTone = 'friendly' | 'professional' | 'casual' | 'exciting';

function parseAiTone(value: unknown): AiTone {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'professional' || normalized === 'casual' || normalized === 'exciting') {
    return normalized;
  }
  return 'friendly';
}

function parsePositiveIntQuery(value: unknown, max: number): number | null {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.min(parsed, max);
}

function parseBooleanQuery(value: unknown): boolean | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }

  return null;
}

const DASHBOARD_CACHE_TTL_MS = 20_000;

function invalidateDashboardReadCaches(): void {
  invalidateShortLivedCache('events:');
  invalidateShortLivedCache('members:my-rsvps:');
}

router.use('/:eventId/rsvp', rsvpRouter);

router.use((req, _res, next) => {
  if (req.method !== 'GET') {
    invalidateDashboardReadCaches();
  }
  next();
});

function getRsvpToken(req: { params: Record<string, string | undefined>; query: Record<string, unknown> }): string {
  const pathToken = req.params.token;
  if (pathToken) {
    return pathToken;
  }

  const queryToken = req.query.token;
  if (typeof queryToken === 'string' && queryToken.length > 0) {
    return queryToken;
  }

  throw new Error('token is required');
}

async function getPublicRsvpContext(tokenString: string): Promise<{
  event_id: string;
  title: string;
  description: string | null;
  location: string | null;
  event_date: string;
  end_date: string | null;
  mentor_capacity: number | null;
  participant_capacity: number | null;
  capacity: number | null;
  status: string;
  member_id: string;
  first_name: string | null;
  current_response: string | null;
  current_response_role: 'MENTOR' | 'PARTICIPANT' | null;
  inferred_response_role: 'MENTOR' | 'PARTICIPANT' | null;
  token_expires_at: string | null;
} | null> {
  const token = verifyRsvpToken(tokenString);
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
      mentor_capacity: number | null;
      participant_capacity: number | null;
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
          e.mentor_capacity,
          e.participant_capacity,
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
    return null;
  }

  return {
    ...row,
    inferred_response_role: (await inferResponseRoleForMember({
      memberId: token.memberId,
      groupContextId: token.groupContextId ?? null,
    })) ?? null,
    token_expires_at: token.expiresAt ?? null,
  };
}

async function submitPublicRsvp(tokenString: string, response: string, responseRole?: 'MENTOR' | 'PARTICIPANT'): Promise<unknown> {
  const token = verifyRsvpToken(tokenString);

  const result = await recordRsvpResponse({
    eventId: token.eventId,
    memberId: token.memberId,
    response: response as RsvpResponse,
    notes: 'Recorded from tokenized RSVP link',
    responseChannel: 'tokenized_link',
    groupContextId: token.groupContextId ?? null,
    responseRole,
  });

  invalidateDashboardReadCaches();
  return result;
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

function resolveResponseRole(
  response: RsvpResponse,
  parsedResponseRole: 'MENTOR' | 'PARTICIPANT' | undefined,
  inferredResponseRole: 'MENTOR' | 'PARTICIPANT' | undefined,
): 'MENTOR' | 'PARTICIPANT' | undefined {
  if (parsedResponseRole) {
    return parsedResponseRole;
  }

  if (inferredResponseRole) {
    return inferredResponseRole;
  }

  // Default role for one-click flow when group context does not imply one.
  return requiresExplicitRole(response) ? 'PARTICIPANT' : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderRsvpActionHtml(title: string, body: string): string {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <style>
      body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 24px; background: #f4f7f9; color: #1f2937; }
      .card { max-width: 640px; margin: 0 auto; background: #fff; border: 1px solid #dbe3ea; border-radius: 10px; padding: 20px; box-shadow: 0 6px 18px rgba(12, 28, 43, 0.08); }
      h1 { margin: 0 0 8px; font-size: 1.35rem; }
      p { margin: 0; line-height: 1.45; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${safeTitle}</h1>
      <p>${safeBody}</p>
    </div>
  </body>
</html>`;
}

router.get('/rsvp/:token/respond', apiLimiter, async (req, res) => {
  try {
    const response = (req.query.response as string | undefined)?.toLowerCase();
    if (!response || !VALID_RESPONSES.includes(response as RsvpResponse)) {
      res.status(400).type('html').send(
        renderRsvpActionHtml('Invalid RSVP response', `Valid options are: ${VALID_RESPONSES.join(', ')}.`)
      );
      return;
    }

    const normalizedResponse = response as RsvpResponse;
    const parsedResponseRole = parseResponseRole(req.query.role);
    const token = verifyRsvpToken(req.params.token);
    const inferredResponseRole = parsedResponseRole
      ? undefined
      : await inferResponseRoleForMember({
        memberId: token.memberId,
        groupContextId: token.groupContextId ?? null,
      });
    const responseRole = resolveResponseRole(normalizedResponse, parsedResponseRole, inferredResponseRole);

    if (req.query.role !== undefined && !parsedResponseRole) {
      res.status(400).type('html').send(
        renderRsvpActionHtml('Invalid role', 'Role must be MENTOR or PARTICIPANT when provided.')
      );
      return;
    }

    await submitPublicRsvp(req.params.token, normalizedResponse, responseRole);
    const normalizedResponseLabel = normalizedResponse.toUpperCase();
    const roleText = responseRole ? ` as ${responseRole}` : '';
    res.status(200).type('html').send(
      renderRsvpActionHtml('RSVP recorded', `Your RSVP is saved: ${normalizedResponseLabel}${roleText}. This confirms one attendee seat for your member profile.`)
    );
  } catch (error) {
    if (error instanceof RsvpError) {
      res.status(error.statusCode).type('html').send(
        renderRsvpActionHtml('Unable to record RSVP', error.message)
      );
      return;
    }

    console.error('GET /events/rsvp/:token/respond failed', error);
    res.status(401).type('html').send(
      renderRsvpActionHtml('Invalid or expired RSVP link', error instanceof Error ? error.message : 'Please request a fresh invitation link.')
    );
  }
});

router.get('/rsvp', apiLimiter, async (req, res) => {
  try {
    const row = await getPublicRsvpContext(getRsvpToken(req));
    if (!row) {
      res.status(404).json({ error: 'Event invite not found' });
      return;
    }

    res.json(row);
  } catch (error) {
    console.error('GET /events/rsvp failed', error);
    res.status(401).json({ error: error instanceof Error ? error.message : 'Invalid or expired RSVP token' });
  }
});

router.post('/rsvp', writeLimiter, async (req, res) => {
  try {
    const response = (req.body?.response as string | undefined)?.toLowerCase();
    const tokenString = getRsvpToken(req);
    const token = verifyRsvpToken(tokenString);
    const parsedResponseRole = parseResponseRole(req.body?.response_role);
    const inferredResponseRole = parsedResponseRole
      ? undefined
      : await inferResponseRoleForMember({
        memberId: token.memberId,
        groupContextId: token.groupContextId ?? null,
      });
    const normalizedResponse = response as RsvpResponse;
    const responseRole = resolveResponseRole(normalizedResponse, parsedResponseRole, inferredResponseRole);

    if (!response) {
      res.status(400).json({ error: `response must be one of: ${VALID_RESPONSES.join(', ')}` });
      return;
    }
    if (!VALID_RESPONSES.includes(response as RsvpResponse)) {
      res.status(400).json({ error: `response must be one of: ${VALID_RESPONSES.join(', ')}` });
      return;
    }

    if (req.body?.response_role !== undefined && !parsedResponseRole) {
      res.status(400).json({ error: 'response_role must be MENTOR or PARTICIPANT when provided' });
      return;
    }

    const record = await submitPublicRsvp(tokenString, normalizedResponse, responseRole);

    res.json(record);
  } catch (error) {
    if (error instanceof RsvpError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }

    console.error('POST /events/rsvp failed', error);
    res.status(401).json({ error: error instanceof Error ? error.message : 'Invalid or expired RSVP token' });
  }
});

router.get('/rsvp/short/:code', apiLimiter, async (req, res) => {
  try {
    const token = await resolveShortRsvpToken(req.params.code);
    if (!token) {
      res.status(404).json({ error: 'RSVP link not found or expired' });
      return;
    }

    res.json({ token });
  } catch (error) {
    console.error('GET /events/rsvp/short/:code failed', error);
    res.status(500).json({ error: 'Unable to resolve RSVP link' });
  }
});

router.get('/rsvp/:token', apiLimiter, async (req, res) => {
  try {
    const row = await getPublicRsvpContext(req.params.token);
    if (!row) {
      res.status(404).json({ error: 'Event invite not found' });
      return;
    }
    res.json(row);
  } catch (error) {
    console.error('GET /events/rsvp/:token failed', error);
    res.status(401).json({ error: error instanceof Error ? error.message : 'Invalid or expired RSVP token' });
  }
});

router.post('/rsvp/:token', writeLimiter, async (req, res) => {
  try {
    const response = (req.body?.response as string | undefined)?.toLowerCase();
    const token = verifyRsvpToken(req.params.token);
    const parsedResponseRole = parseResponseRole(req.body?.response_role);
    const inferredResponseRole = parsedResponseRole
      ? undefined
      : await inferResponseRoleForMember({
        memberId: token.memberId,
        groupContextId: token.groupContextId ?? null,
      });
    const normalizedResponse = response as RsvpResponse;
    const responseRole = resolveResponseRole(normalizedResponse, parsedResponseRole, inferredResponseRole);
    if (!response) {
      res.status(400).json({ error: `response must be one of: ${VALID_RESPONSES.join(', ')}` });
      return;
    }
    if (!VALID_RESPONSES.includes(response as RsvpResponse)) {
      res.status(400).json({ error: `response must be one of: ${VALID_RESPONSES.join(', ')}` });
      return;
    }

    if (req.body?.response_role !== undefined && !parsedResponseRole) {
      res.status(400).json({ error: 'response_role must be MENTOR or PARTICIPANT when provided' });
      return;
    }

    const record = await submitPublicRsvp(req.params.token, normalizedResponse, responseRole);
    res.json(record);
  } catch (error) {
    if (error instanceof RsvpError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    console.error('POST /events/rsvp/:token failed', error);
    res.status(401).json({ error: error instanceof Error ? error.message : 'Invalid or expired RSVP token' });
  }
});

router.get('/', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res) => {
  try {
    const pool = await getPool();
    const status = (req.query.status as string | undefined)?.toLowerCase();
    const upcoming = parseBooleanQuery(req.query.upcoming);
    const limit = parsePositiveIntQuery(req.query.limit, 100);
    const sort = (req.query.sort as string | undefined)?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const cacheKey = [
      'events:list',
      `status=${status ?? 'all'}`,
      `upcoming=${upcoming === null ? 'any' : String(upcoming)}`,
      `limit=${limit ?? 'all'}`,
      `sort=${sort.toLowerCase()}`,
    ].join(':');

    const rows = await withShortLivedCache(cacheKey, DASHBOARD_CACHE_TTL_MS, async () => {
      let query = `
        SELECT
          e.*,
          COALESCE(yes_counts.yes_count, 0) AS yes_count,
          COALESCE(target_counts.target_count, 0) AS target_count
        FROM event e
        LEFT JOIN (
          SELECT er.event_id, COUNT(*) AS yes_count
          FROM event_response er
          WHERE er.response = 'yes'
          GROUP BY er.event_id
        ) AS yes_counts ON yes_counts.event_id = e.event_id
        LEFT JOIN (
          SELECT ent.event_id, COUNT(*) AS target_count
          FROM event_notification_target ent
          GROUP BY ent.event_id
        ) AS target_counts ON target_counts.event_id = e.event_id
      `;

      const request = pool.request();
      const whereClauses: string[] = [];

      if (status) {
        whereClauses.push('e.status = @status');
        request.input('status', sql.NVarChar, status);
      }

      if (upcoming === true) {
        whereClauses.push('e.event_date >= GETUTCDATE()');
      } else if (upcoming === false) {
        whereClauses.push('e.event_date < GETUTCDATE()');
      }

      if (whereClauses.length > 0) {
        query += ` WHERE ${whereClauses.join(' AND ')}`;
      }

      query += ` ORDER BY e.event_date ${sort}`;
      if (limit !== null) {
        request.input('limit', sql.Int, limit);
        query += ' OFFSET 0 ROWS FETCH NEXT @limit ROWS ONLY';
      }

      const result = await request.query(query);
      return result.recordset;
    });

    res.json(rows);
  } catch (error) {
    console.error('GET /events failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/dashboard-summary', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (_req, res) => {
  try {
    const pool = await getPool();
    const summary = await withShortLivedCache('events:dashboard-summary', DASHBOARD_CACHE_TTL_MS, async () => {
      const result = await pool
        .request()
        .query<{
          total_events_this_year: number;
          upcoming_events: number;
          total_rsvps: number;
        }>(
          `SELECT
              (SELECT COUNT(*)
               FROM event e
               WHERE e.status = 'published'
                 AND YEAR(e.event_date) = YEAR(GETUTCDATE())) AS total_events_this_year,
              (SELECT COUNT(*)
               FROM event e
               WHERE e.status = 'published'
                 AND e.event_date >= GETUTCDATE()) AS upcoming_events,
              (SELECT COUNT(*)
               FROM event_response er
               INNER JOIN event e ON e.event_id = er.event_id
               WHERE er.response = 'yes'
                 AND e.status = 'published') AS total_rsvps`
        );

      const row = result.recordset[0] ?? {
        total_events_this_year: 0,
        upcoming_events: 0,
        total_rsvps: 0,
      };

      return {
        totalEventsThisYear: row.total_events_this_year,
        upcomingEvents: row.upcoming_events,
        totalRsvps: row.total_rsvps,
      };
    });

    res.json(summary);
  } catch (error) {
    console.error('GET /events/dashboard-summary failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/ai-draft-preview', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const tone = parseAiTone(req.body?.tone);
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const eventDate = typeof req.body?.event_date === 'string' ? req.body.event_date.trim() : '';
    const location = typeof req.body?.location === 'string' ? req.body.location.trim() : null;
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : null;
    const eventLeadName = typeof req.body?.event_lead_name === 'string' ? req.body.event_lead_name.trim() : null;

    if (!title || !eventDate) {
      res.status(400).json({ error: 'title and event_date are required' });
      return;
    }

    const parsedEventDate = new Date(eventDate);
    if (Number.isNaN(parsedEventDate.getTime())) {
      res.status(400).json({ error: 'event_date must be a valid ISO datetime string' });
      return;
    }

    const draft = await generateInviteDraft({
      eventTitle: title,
      eventDate,
      location,
      description,
      eventLeadName,
      tone,
    });

    res.json({
      ...draft,
      event_id: null,
      tone,
    });
  } catch (error) {
    console.error('POST /events/ai-draft-preview failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/ai-description-preview', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const tone = parseAiTone(req.body?.tone);
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : '';
    const eventDate = typeof req.body?.event_date === 'string' ? req.body.event_date.trim() : '';
    const location = typeof req.body?.location === 'string' ? req.body.location.trim() : null;
    const eventLeadName = typeof req.body?.event_lead_name === 'string' ? req.body.event_lead_name.trim() : null;

    if (!title || !description) {
      res.status(400).json({ error: 'title and description are required' });
      return;
    }

    if (eventDate) {
      const parsedEventDate = new Date(eventDate);
      if (Number.isNaN(parsedEventDate.getTime())) {
        res.status(400).json({ error: 'event_date must be a valid ISO datetime string when provided' });
        return;
      }
    }

    const draft = await generateDescriptionDraft({
      eventTitle: title,
      eventDate: eventDate || null,
      location,
      description,
      eventLeadName,
      tone,
    });

    res.json({
      polished_description: draft.polishedDescription,
      provider: draft.provider,
      tone,
    });
  } catch (error) {
    console.error('POST /events/ai-description-preview failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res) => {
  try {
    const pool = await getPool();
    const eventColumns = await getEventColumnSupport(pool);
    const eventResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query<{
        event_id: string;
        title: string;
        description: string | null;
        location: string | null;
        photo_url: string | null;
        invitation_stage: 'volunteer' | 'participant' | 'both';
        event_lead_member_id: string | null;
        event_lead_name: string | null;
        event_lead_email: string | null;
        event_date: Date | string;
        end_date: Date | string | null;
        mentor_capacity: number | null;
        participant_capacity: number | null;
        capacity: number | null;
        status: 'draft' | 'published' | 'completed' | 'cancelled';
        created_by: string | null;
        created_at: Date | string;
        updated_at: Date | string;
      }>(
        `SELECT
           event_id,
           title,
           description,
           location,
           ${eventColumns.hasPhotoUrl ? 'photo_url' : 'CAST(NULL AS NVARCHAR(1024)) AS photo_url'},
           ${eventColumns.hasInvitationStage ? 'invitation_stage' : "CAST('both' AS NVARCHAR(20)) AS invitation_stage"},
           event_lead_member_id,
           ${EVENT_LEAD_NAME_SELECT},
           ${EVENT_LEAD_EMAIL_SELECT},
           event_date,
           end_date,
           mentor_capacity,
           participant_capacity,
           capacity,
           status,
           created_by,
           created_at,
           updated_at
         FROM event
         WHERE event_id = @event_id`
      );

    const event = eventResult.recordset[0];
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const eventLeadSecondaryRoles = event.event_lead_member_id
      ? await loadLeadSecondaryRoles(pool, req.params.id, event.event_lead_member_id)
      : [];

    const workflow = await getEventEmailWorkflowSettings(req.params.id);

    const targets = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query(
        `SELECT ent.target_id, ent.event_id, ent.group_id, ent.member_id, g.group_name
         FROM event_notification_target ent
         LEFT JOIN [group] g ON g.group_id = ent.group_id
         WHERE ent.event_id = @event_id`
      );

    res.json({
      ...event,
      event_lead_secondary_roles: eventLeadSecondaryRoles,
      scheduler_email: workflow.schedulerEmail,
      notification_targets: targets.recordset,
    });
  } catch (error) {
    console.error('GET /events/:id failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const title = req.body?.title as string | undefined;
    const eventDate = req.body?.event_date as string | undefined;
    if (!title || !eventDate) {
      res.status(400).json({ error: 'title and event_date are required' });
      return;
    }

    const description = (req.body?.description as string | undefined) ?? null;
    const location = (req.body?.location as string | undefined) ?? null;
    const photoUrl = parsePhotoUrl(req.body?.photo_url);
    const invitationStage = parseInvitationStage(req.body?.invitation_stage);
    const eventLeadMemberIdRaw = req.body?.event_lead_member_id;
    const eventLeadMemberId = eventLeadMemberIdRaw === null || eventLeadMemberIdRaw === undefined
      ? null
      : asUuidOrNull(eventLeadMemberIdRaw);
    const eventLeadSecondaryRoles = parseEventLeadSecondaryRoles(req.body?.event_lead_secondary_roles);
    if (eventLeadMemberIdRaw !== undefined && eventLeadMemberIdRaw !== null && !eventLeadMemberId) {
      res.status(400).json({ error: 'event_lead_member_id must be a valid UUID when provided' });
      return;
    }
    if (eventLeadSecondaryRoles === null) {
      res.status(400).json({ error: 'event_lead_secondary_roles must be an array of MENTOR/PARTICIPANT' });
      return;
    }
    if (!eventLeadMemberId && eventLeadSecondaryRoles.length > 0) {
      res.status(400).json({ error: 'event_lead_secondary_roles requires event_lead_member_id' });
      return;
    }
    if (req.body?.scheduler_email !== undefined && normalizeString(req.body?.scheduler_email) && !parseOptionalEmail(req.body?.scheduler_email)) {
      res.status(400).json({ error: 'scheduler_email must be a valid email address when provided' });
      return;
    }
    const schedulerEmail = parseOptionalEmail(req.body?.scheduler_email);
    const endDate = (req.body?.end_date as string | undefined) ?? null;
    const mentorCapacity = parseCapacity(req.body?.mentor_capacity);
    const participantCapacity = parseCapacity(req.body?.participant_capacity);
    const legacyCapacity = parseCapacity(req.body?.capacity);
    const computedCapacity = (mentorCapacity ?? 0) + (participantCapacity ?? 0);
    const capacity = computedCapacity > 0 ? computedCapacity : legacyCapacity;
    const rawTargets = Array.isArray(req.body?.notification_targets) ? req.body.notification_targets : [];
    const createdBy = null;
    const creatorEmail = parseOptionalEmail(req.user?.email ?? req.user?.sub);

    const parsedEventDate = new Date(eventDate);
    if (Number.isNaN(parsedEventDate.getTime())) {
      res.status(400).json({ error: 'event_date must be a valid ISO datetime string' });
      return;
    }

    const parsedEndDate = endDate ? new Date(endDate) : null;
    if (parsedEndDate && Number.isNaN(parsedEndDate.getTime())) {
      res.status(400).json({ error: 'end_date must be a valid ISO datetime string when provided' });
      return;
    }

    if (parsedEndDate && parsedEndDate.getTime() < parsedEventDate.getTime()) {
      res.status(400).json({ error: 'end_date cannot be before event_date' });
      return;
    }

    const targetGroupIds: string[] = [];
    for (const target of rawTargets) {
      if (!target || typeof target !== 'object') {
        continue;
      }

      const parsedGroupId = asUuidOrNull((target as { group_id?: unknown }).group_id);
      if (!parsedGroupId) {
        res.status(400).json({ error: 'notification_targets must contain valid group_id UUIDs' });
        return;
      }

      targetGroupIds.push(parsedGroupId);
    }

    const pool = await getPool();
    const eventColumns = await getEventColumnSupport(pool);

    if (eventLeadMemberId) {
      await assertEventLeadEligibility(pool, eventLeadMemberId);
    }

    const createRequest = pool
      .request()
      .input('title', sql.NVarChar, title)
      .input('description', sql.NVarChar(sql.MAX), description)
      .input('location', sql.NVarChar, location)
      .input('event_date', sql.DateTime, parsedEventDate)
      .input('end_date', sql.DateTime, parsedEndDate)
      .input('mentor_capacity', sql.Int, mentorCapacity)
      .input('participant_capacity', sql.Int, participantCapacity)
      .input('capacity', sql.Int, capacity)
      .input('created_by', sql.UniqueIdentifier, createdBy);

    const insertColumns = [
      'event_id',
      'title',
      'description',
      'location',
      'event_date',
      'end_date',
      'mentor_capacity',
      'participant_capacity',
      'capacity',
      'status',
      'created_by',
      'created_at',
      'updated_at',
    ];
    const insertValues = [
      'NEWID()',
      '@title',
      '@description',
      '@location',
      '@event_date',
      '@end_date',
      '@mentor_capacity',
      '@participant_capacity',
      '@capacity',
      "'draft'",
      '@created_by',
      'GETUTCDATE()',
      'GETUTCDATE()',
    ];

    if (eventColumns.hasPhotoUrl) {
      insertColumns.splice(4, 0, 'photo_url');
      insertValues.splice(4, 0, '@photo_url');
      createRequest.input('photo_url', sql.NVarChar(1024), photoUrl);
    }
    if (eventColumns.hasInvitationStage) {
      const insertIndex = eventColumns.hasPhotoUrl ? 5 : 4;
      insertColumns.splice(insertIndex, 0, 'invitation_stage');
      insertValues.splice(insertIndex, 0, '@invitation_stage');
      createRequest.input('invitation_stage', sql.NVarChar(20), invitationStage);
    }

    // Event lead is now a FK to member; persist only when caller supplied a valid UUID.
    if (eventLeadMemberId) {
      insertColumns.push('event_lead_member_id');
      insertValues.push('@event_lead_member_id');
      createRequest.input('event_lead_member_id', sql.UniqueIdentifier, eventLeadMemberId);
    }

    const created = await createRequest.query(
      `INSERT INTO event (${insertColumns.join(', ')})
       OUTPUT INSERTED.*
       VALUES (${insertValues.join(', ')})`
    );

    const event = created.recordset[0];

    if (eventLeadMemberId) {
      await ensureEventLeadAssignments(pool, event.event_id, eventLeadMemberId, eventLeadSecondaryRoles);
    }

    await upsertEventEmailWorkflowSettings({
      eventId: event.event_id,
      schedulerEmail,
      creatorEmail,
      updatedBy: req.user?.email ?? req.user?.sub ?? 'unknown',
    });

    for (const groupId of targetGroupIds) {
      try {
        await pool
          .request()
          .input('target_id', sql.UniqueIdentifier, cryptoRandomUuid())
          .input('event_id', sql.UniqueIdentifier, event.event_id)
          .input('group_id', sql.UniqueIdentifier, groupId)
          .query(
            `INSERT INTO event_notification_target (target_id, event_id, group_id, member_id)
             VALUES (@target_id, @event_id, @group_id, NULL)`
          );
      } catch (targetInsertError) {
        if (typeof targetInsertError === 'object' && targetInsertError && 'number' in targetInsertError && (targetInsertError as { number?: number }).number === 547) {
          res.status(400).json({ error: `Unknown target group_id: ${groupId}` });
          return;
        }
        throw targetInsertError;
      }
    }

    res.status(201).json({ ...event, scheduler_email: schedulerEmail });
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    console.error('POST /events failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    const eventColumns = await getEventColumnSupport(pool);
    const existingResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query<{
        status: string;
        title: string;
        description: string | null;
        location: string | null;
        photo_url: string | null;
        invitation_stage: 'volunteer' | 'participant' | 'both';
        event_lead_member_id: string | null;
        event_lead_name: string | null;
        event_lead_email: string | null;
        event_date: Date | string;
        end_date: Date | string | null;
        mentor_capacity: number | null;
        participant_capacity: number | null;
        capacity: number | null;
      }>(
        `SELECT
           status,
           title,
           description,
           location,
           ${eventColumns.hasPhotoUrl ? 'photo_url' : 'CAST(NULL AS NVARCHAR(1024)) AS photo_url'},
           ${eventColumns.hasInvitationStage ? 'invitation_stage' : "CAST('both' AS NVARCHAR(20)) AS invitation_stage"},
           event_lead_member_id,
           ${EVENT_LEAD_NAME_SELECT},
           ${EVENT_LEAD_EMAIL_SELECT},
           event_date,
           end_date,
           mentor_capacity,
           participant_capacity,
           capacity
         FROM event
         WHERE event_id = @event_id`
      );

    const existing = existingResult.recordset[0];
    if (!existing) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (existing.status === 'completed' || existing.status === 'cancelled') {
      res.status(409).json({ error: `Cannot edit event in ${existing.status} status` });
      return;
    }

    const changedFields: string[] = [];
    const proposedTitle = req.body?.title;
    const proposedDescription = req.body?.description;
    const proposedLocation = req.body?.location;
    const proposedPhotoUrl = req.body?.photo_url;
    const proposedInvitationStage = req.body?.invitation_stage;
    const proposedEventLeadMemberIdRaw = req.body?.event_lead_member_id;
    const hasEventLeadSecondaryRolesInput = req.body?.event_lead_secondary_roles !== undefined;
    const proposedEventLeadSecondaryRoles = parseEventLeadSecondaryRoles(req.body?.event_lead_secondary_roles);
    const proposedSchedulerEmail = req.body?.scheduler_email;
    const proposedEventDate = req.body?.event_date;
    const proposedEndDate = req.body?.end_date;
    const proposedMentorCapacity = req.body?.mentor_capacity;
    const proposedParticipantCapacity = req.body?.participant_capacity;
    const proposedCapacity = req.body?.capacity;

    if (proposedTitle !== undefined && normalizeString(proposedTitle) !== normalizeString(existing.title)) {
      changedFields.push('title');
    }
    if (proposedDescription !== undefined && normalizeString(proposedDescription) !== normalizeString(existing.description)) {
      changedFields.push('description');
    }
    if (proposedLocation !== undefined && normalizeString(proposedLocation) !== normalizeString(existing.location)) {
      changedFields.push('location');
    }
    if (eventColumns.hasPhotoUrl && proposedPhotoUrl !== undefined && normalizeString(proposedPhotoUrl) !== normalizeString(existing.photo_url)) {
      changedFields.push('photo_url');
    }
    if (eventColumns.hasInvitationStage && proposedInvitationStage !== undefined && normalizeString(proposedInvitationStage) !== normalizeString(existing.invitation_stage)) {
      changedFields.push('invitation_stage');
    }
    if (proposedEventLeadMemberIdRaw !== undefined) {
      const proposedEventLeadMemberId = proposedEventLeadMemberIdRaw === null ? null : asUuidOrNull(proposedEventLeadMemberIdRaw);
      if (proposedEventLeadMemberIdRaw !== null && !proposedEventLeadMemberId) {
        res.status(400).json({ error: 'event_lead_member_id must be a valid UUID when provided' });
        return;
      }
      if ((proposedEventLeadMemberId ?? null) !== (existing.event_lead_member_id ?? null)) {
        changedFields.push('event_lead_member_id');
      }
    }
    if (hasEventLeadSecondaryRolesInput) {
      if (proposedEventLeadSecondaryRoles === null) {
        res.status(400).json({ error: 'event_lead_secondary_roles must be an array of MENTOR/PARTICIPANT' });
        return;
      }
      changedFields.push('event_lead_secondary_roles');
    }
    if (proposedSchedulerEmail !== undefined) {
      changedFields.push('scheduler_email');
    }
    if (proposedEventDate !== undefined && toUtcMillis(proposedEventDate) !== toUtcMillis(existing.event_date)) {
      changedFields.push('event_date');
    }
    if (proposedEndDate !== undefined && toUtcMillis(proposedEndDate) !== toUtcMillis(existing.end_date)) {
      changedFields.push('end_date');
    }
    if (proposedMentorCapacity !== undefined && normalizeNumber(proposedMentorCapacity) !== normalizeNumber(existing.mentor_capacity)) {
      changedFields.push('mentor_capacity');
    }
    if (proposedParticipantCapacity !== undefined && normalizeNumber(proposedParticipantCapacity) !== normalizeNumber(existing.participant_capacity)) {
      changedFields.push('participant_capacity');
    }
    if (proposedCapacity !== undefined && normalizeNumber(proposedCapacity) !== normalizeNumber(existing.capacity)) {
      changedFields.push('capacity');
    }

    const updates: string[] = ['updated_at = GETUTCDATE()'];
    const request = pool.request().input('event_id', sql.UniqueIdentifier, req.params.id);

    if (req.body?.title !== undefined) {
      updates.push('title = @title');
      request.input('title', sql.NVarChar, req.body.title);
    }
    if (req.body?.description !== undefined) {
      updates.push('description = @description');
      request.input('description', sql.NVarChar(sql.MAX), req.body.description);
    }
    if (req.body?.location !== undefined) {
      updates.push('location = @location');
      request.input('location', sql.NVarChar, req.body.location);
    }
    if (eventColumns.hasPhotoUrl && req.body?.photo_url !== undefined) {
      updates.push('photo_url = @photo_url');
      request.input('photo_url', sql.NVarChar(1024), parsePhotoUrl(req.body.photo_url));
    }
    if (eventColumns.hasInvitationStage && req.body?.invitation_stage !== undefined) {
      updates.push('invitation_stage = @invitation_stage');
      request.input('invitation_stage', sql.NVarChar(20), parseInvitationStage(req.body.invitation_stage));
    }
    if (req.body?.event_lead_member_id !== undefined) {
      const newLeadMemberId = req.body.event_lead_member_id === null ? null : asUuidOrNull(req.body.event_lead_member_id);
      if (req.body.event_lead_member_id !== null && !newLeadMemberId) {
        res.status(400).json({ error: 'event_lead_member_id must be a valid UUID when provided' });
        return;
      }
      updates.push('event_lead_member_id = @event_lead_member_id');
      request.input('event_lead_member_id', sql.UniqueIdentifier, newLeadMemberId);
    }

    const nextLeadMemberId = req.body?.event_lead_member_id !== undefined
      ? (req.body.event_lead_member_id === null ? null : asUuidOrNull(req.body.event_lead_member_id))
      : (existing.event_lead_member_id ?? null);
    const existingLeadSecondaryRoles = existing.event_lead_member_id
      ? await loadLeadSecondaryRoles(pool, req.params.id, existing.event_lead_member_id)
      : [];
    const nextLeadSecondaryRoles = hasEventLeadSecondaryRolesInput
      ? (proposedEventLeadSecondaryRoles ?? [])
      : (nextLeadMemberId && nextLeadMemberId === existing.event_lead_member_id ? existingLeadSecondaryRoles : []);

    if (!nextLeadMemberId && nextLeadSecondaryRoles.length > 0) {
      res.status(400).json({ error: 'event_lead_secondary_roles requires event_lead_member_id' });
      return;
    }

    const nextMentorCapacity = req.body?.mentor_capacity !== undefined
      ? parseCapacity(req.body.mentor_capacity)
      : normalizeNumber(existing.mentor_capacity);
    const nextParticipantCapacity = req.body?.participant_capacity !== undefined
      ? parseCapacity(req.body.participant_capacity)
      : normalizeNumber(existing.participant_capacity);

    if (nextLeadMemberId && (req.body?.event_lead_member_id !== undefined || hasEventLeadSecondaryRolesInput || req.body?.mentor_capacity !== undefined || req.body?.participant_capacity !== undefined)) {
      await assertEventLeadEligibility(pool, nextLeadMemberId);
      await assertLeadSecondaryRoleCapacity(pool, req.params.id, nextLeadMemberId, nextLeadSecondaryRoles, {
        mentorCapacity: nextMentorCapacity,
        participantCapacity: nextParticipantCapacity,
      });
    }
    if (req.body?.scheduler_email !== undefined && normalizeString(req.body?.scheduler_email) && !parseOptionalEmail(req.body?.scheduler_email)) {
      res.status(400).json({ error: 'scheduler_email must be a valid email address when provided' });
      return;
    }
    if (req.body?.event_date !== undefined) {
      updates.push('event_date = @event_date');
      request.input('event_date', sql.DateTime, new Date(req.body.event_date));
    }
    if (req.body?.end_date !== undefined) {
      updates.push('end_date = @end_date');
      request.input('end_date', sql.DateTime, req.body.end_date ? new Date(req.body.end_date) : null);
    }
    if (req.body?.mentor_capacity !== undefined) {
      updates.push('mentor_capacity = @mentor_capacity');
      request.input('mentor_capacity', sql.Int, parseCapacity(req.body.mentor_capacity));
    }
    if (req.body?.participant_capacity !== undefined) {
      updates.push('participant_capacity = @participant_capacity');
      request.input('participant_capacity', sql.Int, parseCapacity(req.body.participant_capacity));
    }

    const hasRoleCapacityInput = req.body?.mentor_capacity !== undefined || req.body?.participant_capacity !== undefined;
    if (req.body?.capacity !== undefined) {
      updates.push('capacity = @capacity');
      request.input('capacity', sql.Int, parseCapacity(req.body.capacity));
    } else if (hasRoleCapacityInput) {
      const nextMentor = req.body?.mentor_capacity !== undefined
        ? parseCapacity(req.body.mentor_capacity)
        : normalizeNumber(existing.mentor_capacity);
      const nextParticipant = req.body?.participant_capacity !== undefined
        ? parseCapacity(req.body.participant_capacity)
        : normalizeNumber(existing.participant_capacity);
      const combined = (nextMentor ?? 0) + (nextParticipant ?? 0);
      updates.push('capacity = @capacity');
      request.input('capacity', sql.Int, combined > 0 ? combined : null);
    }

    const updated = await request.query(
      `UPDATE event SET ${updates.join(', ')}
       OUTPUT INSERTED.*
       WHERE event_id = @event_id`
    );

    let addedTargetGroupIds: string[] = [];
    if (Array.isArray(req.body?.notification_targets)) {
      const requestedGroupIds: string[] = [];
      for (const target of req.body.notification_targets) {
        if (!target || typeof target !== 'object') {
          continue;
        }
        const parsedGroupId = asUuidOrNull((target as { group_id?: unknown }).group_id);
        if (!parsedGroupId) {
          res.status(400).json({ error: 'notification_targets must contain valid group_id UUIDs' });
          return;
        }
        requestedGroupIds.push(parsedGroupId);
      }

      const requestedUniqueGroupIds = Array.from(new Set(requestedGroupIds));
      const existingTargetsResult = await pool
        .request()
        .input('event_id', sql.UniqueIdentifier, req.params.id)
        .query<{ group_id: string | null }>(
          `SELECT DISTINCT group_id
           FROM event_notification_target
           WHERE event_id = @event_id
             AND group_id IS NOT NULL`
        );

      const existingGroupIds = new Set(
        existingTargetsResult.recordset
          .map((row) => row.group_id)
          .filter((groupId): groupId is string => Boolean(groupId))
      );
      addedTargetGroupIds = requestedUniqueGroupIds.filter((groupId) => !existingGroupIds.has(groupId));

      await pool
        .request()
        .input('event_id', sql.UniqueIdentifier, req.params.id)
        .query('DELETE FROM event_notification_target WHERE event_id = @event_id');

      for (const groupId of requestedUniqueGroupIds) {
        await pool
          .request()
          .input('target_id', sql.UniqueIdentifier, cryptoRandomUuid())
          .input('event_id', sql.UniqueIdentifier, req.params.id)
          .input('group_id', sql.UniqueIdentifier, groupId)
          .query(
            `INSERT INTO event_notification_target (target_id, event_id, group_id, member_id)
             VALUES (@target_id, @event_id, @group_id, NULL)`
          );
      }
    }

    if (req.body?.scheduler_email !== undefined) {
      await upsertEventEmailWorkflowSettings({
        eventId: req.params.id,
        schedulerEmail: parseOptionalEmail(req.body?.scheduler_email),
        creatorEmail: parseOptionalEmail(req.user?.email ?? req.user?.sub),
        updatedBy: req.user?.email ?? req.user?.sub ?? 'unknown',
      });
    }

    if (req.body?.event_lead_member_id !== undefined || hasEventLeadSecondaryRolesInput) {
      await ensureEventLeadAssignments(pool, req.params.id, nextLeadMemberId, nextLeadSecondaryRoles);
    }

    let notificationWarning: string | null = null;
    if (existing.status === 'published' && addedTargetGroupIds.length > 0) {
      const updatedEvent = updated.recordset[0] as {
        event_id?: string;
        title?: string;
        event_date?: Date | string;
        location?: string | null;
        description?: string | null;
        photo_url?: string | null;
        invitation_stage?: 'volunteer' | 'participant' | 'both' | null;
        event_lead_name?: string | null;
        event_lead_email?: string | null;
      };

      const publishPayload = {
        event_id: updatedEvent.event_id ?? req.params.id,
        title: updatedEvent.title ?? existing.title,
        event_date: updatedEvent.event_date ?? existing.event_date,
        location: updatedEvent.location ?? existing.location,
        description: updatedEvent.description ?? existing.description,
        photo_url: updatedEvent.photo_url ?? existing.photo_url,
        invitation_stage: updatedEvent.invitation_stage ?? existing.invitation_stage,
        event_lead_name: updatedEvent.event_lead_name ?? existing.event_lead_name,
        event_lead_email: updatedEvent.event_lead_email ?? existing.event_lead_email,
      };

      // Send in background so event edits do not appear hung while notifications dispatch.
      void Promise.resolve(sendEventPublishedNotification(publishPayload, {
        targetGroupIds: addedTargetGroupIds,
        skipCooldown: true,
      })).catch((error) => {
        if (isNotificationConfigurationError(error)) {
          console.error('PUT /events/:id new-target publish notification config error', error);
          return;
        }
        console.error('PUT /events/:id new-target publish notification failed', error);
      });

      notificationWarning = 'Event saved. Invite notifications to newly added target groups are being sent in the background.';
    }

    const workflow = await getEventEmailWorkflowSettings(req.params.id);
    const responsePayload = { ...updated.recordset[0], scheduler_email: workflow.schedulerEmail };
    res.json(notificationWarning ? { ...responsePayload, notification_warning: notificationWarning } : responsePayload);
  } catch (error) {
    if (error instanceof HttpError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (isNotificationConfigurationError(error)) {
      res.status(503).json({ error: error.message });
      return;
    }

    console.error('PUT /events/:id failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/send-update', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const updateReason = normalizeString(req.body?.update_reason ?? req.body?.reason);
    if (!updateReason) {
      res.status(400).json({ error: 'update_reason is required' });
      return;
    }

    const pool = await getPool();
    const eventColumns = await getEventColumnSupport(pool);
    const eventResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query<{
        event_id: string;
        status: string;
        title: string;
        event_date: Date | string;
        location: string | null;
        description: string | null;
        photo_url: string | null;
        invitation_stage: 'volunteer' | 'participant' | 'both';
        event_lead_member_id: string | null;
        event_lead_name: string | null;
        event_lead_email: string | null;
      }>(
        `SELECT
           event_id,
           status,
           title,
           event_date,
           location,
           description,
           ${eventColumns.hasPhotoUrl ? 'photo_url' : 'CAST(NULL AS NVARCHAR(1024)) AS photo_url'},
           ${eventColumns.hasInvitationStage ? 'invitation_stage' : "CAST('both' AS NVARCHAR(20)) AS invitation_stage"},
           event_lead_member_id,
           ${EVENT_LEAD_NAME_SELECT},
           ${EVENT_LEAD_EMAIL_SELECT}
         FROM event
         WHERE event_id = @event_id`
      );

    const event = eventResult.recordset[0];
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (event.status !== 'published') {
      res.status(409).json({ error: 'Update notifications can only be sent for published events.' });
      return;
    }

    try {
      await assertEventUpdatedNotificationReady(event.event_id);
    } catch (error) {
      if (isNotificationConfigurationError(error)) {
        throw error;
      }
      console.error('POST /events/:id/send-update readiness check failed', error);
    }

    const changedFields = Array.isArray(req.body?.changed_fields)
      ? (req.body.changed_fields as unknown[]).filter((field): field is string => typeof field === 'string' && field.trim().length > 0)
      : ['details'];

    await sendEventUpdatedNotification({
      event_id: event.event_id,
      title: event.title,
      event_date: event.event_date,
      location: event.location,
      description: event.description,
      photo_url: event.photo_url,
      invitation_stage: event.invitation_stage,
      event_lead_name: event.event_lead_name,
      event_lead_email: event.event_lead_email,
      changedFields: changedFields.length > 0 ? changedFields : ['details'],
      changeSummary: normalizeString(req.body?.change_summary),
      updateReason,
    });

    res.status(200).json({ ok: true, event_id: event.event_id, sent: true });
  } catch (error) {
    if (isNotificationConfigurationError(error)) {
      res.status(503).json({ error: error.message });
      return;
    }

    console.error('POST /events/:id/send-update failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/send-reminder', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    const eventColumns = await getEventColumnSupport(pool);
    const eventResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query<{
        event_id: string;
        status: string;
        title: string;
        event_date: Date | string;
        location: string | null;
        description: string | null;
        photo_url: string | null;
        invitation_stage: 'volunteer' | 'participant' | 'both';
        event_lead_member_id: string | null;
        event_lead_name: string | null;
        event_lead_email: string | null;
      }>(
        `SELECT
           event_id,
           status,
           title,
           event_date,
           location,
           description,
           ${eventColumns.hasPhotoUrl ? 'photo_url' : 'CAST(NULL AS NVARCHAR(1024)) AS photo_url'},
           ${eventColumns.hasInvitationStage ? 'invitation_stage' : "CAST('both' AS NVARCHAR(20)) AS invitation_stage"},
           event_lead_member_id,
           ${EVENT_LEAD_NAME_SELECT},
           ${EVENT_LEAD_EMAIL_SELECT}
         FROM event
         WHERE event_id = @event_id`
      );

    const event = eventResult.recordset[0];
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (event.status !== 'published') {
      res.status(409).json({ error: 'Reminders can only be sent for published events.' });
      return;
    }

    await sendEventRsvpReminderToNonResponders({
      event_id: event.event_id,
      title: event.title,
      event_date: event.event_date,
      location: event.location,
      description: event.description,
      photo_url: event.photo_url,
      invitation_stage: event.invitation_stage,
      event_lead_name: event.event_lead_name,
      event_lead_email: event.event_lead_email,
    });

    res.status(200).json({ ok: true, event_id: event.event_id, sent: true });
  } catch (error) {
    if (isNotificationConfigurationError(error)) {
      res.status(503).json({ error: error.message });
      return;
    }

    console.error('POST /events/:id/send-reminder failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/status', writeLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res) => {
  try {
    const newStatus = (req.body?.status as string | undefined)?.toLowerCase();
    if (!newStatus) {
      res.status(400).json({ error: 'status is required' });
      return;
    }

    const pool = await getPool();
    const eventColumns = await getEventColumnSupport(pool);
    const existingResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query<{
        event_id: string;
        status: string;
        title: string;
        event_date: Date | string;
        location: string | null;
        description: string | null;
        photo_url: string | null;
        invitation_stage: 'volunteer' | 'participant' | 'both';
        event_lead_member_id: string | null;
        event_lead_name: string | null;
        event_lead_email: string | null;
      }>(
        `SELECT
           event_id,
           status,
           title,
           event_date,
           location,
           description,
           ${eventColumns.hasPhotoUrl ? 'photo_url' : 'CAST(NULL AS NVARCHAR(1024)) AS photo_url'},
           ${eventColumns.hasInvitationStage ? 'invitation_stage' : "CAST('both' AS NVARCHAR(20)) AS invitation_stage"},
           event_lead_member_id,
           ${EVENT_LEAD_NAME_SELECT},
           ${EVENT_LEAD_EMAIL_SELECT}
         FROM event
         WHERE event_id = @event_id`
      );

    const existing = existingResult.recordset[0];
    if (!existing) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const allowed = STATUS_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(newStatus)) {
      res.status(409).json({ error: `Cannot transition from ${existing.status} to ${newStatus}` });
      return;
    }

    let notificationWarning: string | null = null;

    if (newStatus === 'published') {
      const targetCountResult = await pool
        .request()
        .input('event_id', sql.UniqueIdentifier, req.params.id)
        .query<{ target_count: number }>(
          `SELECT COUNT(*) AS target_count
           FROM event_notification_target
           WHERE event_id = @event_id
             AND group_id IS NOT NULL`
        );
      const targetCount = targetCountResult.recordset[0]?.target_count ?? 0;
      if (targetCount === 0) {
        res.status(400).json({ error: 'At least one target group is required before publishing.' });
        return;
      }

      try {
        await assertEventPublishedNotificationReady(req.params.id);
      } catch (error) {
        if (isNotificationConfigurationError(error)) {
          throw error;
        }
        notificationWarning = 'Event status changed, but publish notification readiness checks failed.';
        console.error('PUT /events/:id/status publish readiness check failed', error);
      }
    }
    if (newStatus === 'cancelled') {
      try {
        await assertEventCancelledNotificationReady(req.params.id);
      } catch (error) {
        if (isNotificationConfigurationError(error)) {
          throw error;
        }
        notificationWarning = 'Event status changed, but cancellation notification readiness checks failed.';
        console.error('PUT /events/:id/status cancellation readiness check failed', error);
      }
    }

    const updated = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .input('status', sql.NVarChar, newStatus)
      .query(
        `UPDATE event
         SET status = @status, updated_at = GETUTCDATE()
         OUTPUT INSERTED.*
         WHERE event_id = @event_id`
      );

    if (newStatus === 'published') {
      const publishPayload = {
        event_id: existing.event_id,
        title: existing.title,
        event_date: existing.event_date,
        location: existing.location,
        description: existing.description,
        photo_url: existing.photo_url,
        invitation_stage: existing.invitation_stage ?? 'both',
        event_lead_name: existing.event_lead_name,
        event_lead_email: existing.event_lead_email,
      };

      // Dispatch in background so publish does not block on provider latency.
      void Promise.resolve(sendEventPublishedNotification(publishPayload)).catch((error) => {
        if (isNotificationConfigurationError(error)) {
          console.error('PUT /events/:id/status publish notification config error', error);
          return;
        }
        console.error('PUT /events/:id/status publish notification failed', error);
      });

      notificationWarning = 'Event status changed. Publish notifications are being sent in the background.';
    }
    if (newStatus === 'cancelled') {
      try {
        await sendEventCancelledNotification({
          event_id: existing.event_id,
          title: existing.title,
          event_date: existing.event_date,
          location: existing.location,
          description: existing.description,
          photo_url: existing.photo_url,
          invitation_stage: existing.invitation_stage,
          event_lead_name: existing.event_lead_name,
          event_lead_email: existing.event_lead_email,
          updateReason: (req.body?.reason as string | undefined) ?? (req.body?.cancellation_reason as string | undefined) ?? null,
        });
      } catch (error) {
        if (isNotificationConfigurationError(error)) {
          throw error;
        }
        notificationWarning = 'Event status changed, but cancellation notifications failed.';
        console.error('PUT /events/:id/status cancellation notification failed', error);
      }
    }
    if (newStatus === 'completed') {
      if (existing.event_lead_member_id) {
        await pool
          .request()
          .input('event_id', sql.UniqueIdentifier, req.params.id)
          .query(
            `UPDATE event_assignment
             SET attended = 1
             WHERE event_id = @event_id
               AND role = 'LEAD'
               AND attended IS NULL`
          );
      }

      try {
        await sendEventCompletedNotification({
          event_id: existing.event_id,
          title: existing.title,
          event_date: existing.event_date,
          location: existing.location,
          description: existing.description,
          photo_url: existing.photo_url,
          invitation_stage: existing.invitation_stage,
          event_lead_name: existing.event_lead_name,
          event_lead_email: existing.event_lead_email,
        });
      } catch (error) {
        if (isNotificationConfigurationError(error)) {
          throw error;
        }
        notificationWarning = 'Event status changed, but completion notifications failed.';
        console.error('PUT /events/:id/status completion notification failed', error);
      }
    }

    res.json({
      ...updated.recordset[0],
      ...(notificationWarning ? { notification_warning: notificationWarning } : {}),
    });
  } catch (error) {
    if (isNotificationConfigurationError(error)) {
      res.status(503).json({ error: error.message });
      return;
    }

    console.error('PUT /events/:id/status failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/close-at-capacity', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    const eventResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query<{
        event_id: string;
        status: string;
      }>(
        `SELECT event_id, status
         FROM event
         WHERE event_id = @event_id`
      );

    const event = eventResult.recordset[0];
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (event.status !== 'published') {
      res.status(409).json({ error: 'Only published events can be closed at capacity.' });
      return;
    }

    const countsResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query<{
        assigned_mentor_count: number;
        assigned_participant_count: number;
        yes_mentor_count: number;
        yes_participant_count: number;
      }>(
        `SELECT
            (SELECT COUNT(*) FROM event_assignment WHERE event_id = @event_id AND role = 'MENTOR') AS assigned_mentor_count,
            (SELECT COUNT(*) FROM event_assignment WHERE event_id = @event_id AND role = 'PARTICIPANT') AS assigned_participant_count,
            (SELECT COUNT(*) FROM event_response WHERE event_id = @event_id AND response = 'yes' AND response_role = 'MENTOR') AS yes_mentor_count,
            (SELECT COUNT(*) FROM event_response WHERE event_id = @event_id AND response = 'yes' AND response_role = 'PARTICIPANT') AS yes_participant_count`
      );

    const counts = countsResult.recordset[0] ?? {
      assigned_mentor_count: 0,
      assigned_participant_count: 0,
      yes_mentor_count: 0,
      yes_participant_count: 0,
    };

    const mentorCapacity = Math.max(counts.assigned_mentor_count ?? 0, counts.yes_mentor_count ?? 0, 0);
    const participantCapacity = Math.max(counts.assigned_participant_count ?? 0, counts.yes_participant_count ?? 0, 0);
    const totalCapacity = mentorCapacity + participantCapacity;

    const updatedResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .input('mentor_capacity', sql.Int, mentorCapacity)
      .input('participant_capacity', sql.Int, participantCapacity)
      .input('capacity', sql.Int, totalCapacity)
      .query<{
        event_id: string;
        mentor_capacity: number | null;
        participant_capacity: number | null;
        capacity: number | null;
        status: string;
      }>(
        `UPDATE event
         SET mentor_capacity = @mentor_capacity,
             participant_capacity = @participant_capacity,
             capacity = @capacity,
             updated_at = GETUTCDATE()
         OUTPUT INSERTED.event_id, INSERTED.mentor_capacity, INSERTED.participant_capacity, INSERTED.capacity, INSERTED.status
         WHERE event_id = @event_id`
      );

    res.status(200).json({
      event: updatedResult.recordset[0],
      snapshot: {
        assigned_mentor_count: counts.assigned_mentor_count ?? 0,
        assigned_participant_count: counts.assigned_participant_count ?? 0,
        yes_mentor_count: counts.yes_mentor_count ?? 0,
        yes_participant_count: counts.yes_participant_count ?? 0,
      },
      message: 'Event capacity has been locked at current assigned/confirmed counts. New yes RSVPs will be routed to waitlist when full.',
    });
  } catch (error) {
    console.error('POST /events/:id/close-at-capacity failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/ics', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res) => {
  try {
    const pool = await getPool();
    const eventResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query<{
        event_id: string;
        title: string;
        description: string | null;
        location: string | null;
        event_date: Date;
        end_date: Date | null;
        status: string;
      }>(
        `SELECT event_id, title, description, location, event_date, end_date, status
         FROM event
         WHERE event_id = @event_id`
      );

    const event = eventResult.recordset[0];
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const startDate = new Date(event.event_date);
    if (Number.isNaN(startDate.getTime())) {
      res.status(422).json({ error: 'Event date is invalid for ICS export' });
      return;
    }

    const endDate = event.end_date ? new Date(event.end_date) : new Date(startDate.getTime() + 2 * 60 * 60 * 1000);
    const nowStamp = formatIcsUtc(new Date());
    const uid = `${event.event_id}@phw-alpine-events`;
    const status = event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED';

    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//PHW Alpine Events//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${escapeIcsText(uid)}`,
      `DTSTAMP:${nowStamp}`,
      `DTSTART:${formatIcsUtc(startDate)}`,
      `DTEND:${formatIcsUtc(endDate)}`,
      `SUMMARY:${escapeIcsText(event.title)}`,
      `DESCRIPTION:${escapeIcsText(event.description ?? '')}`,
      `LOCATION:${escapeIcsText(event.location ?? '')}`,
      `STATUS:${status}`,
      'END:VEVENT',
      'END:VCALENDAR',
      '',
    ];

    const icsContent = lines.join('\r\n');
    const fileName = `phw-event-${event.event_id}.ics`;

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(icsContent);
  } catch (error) {
    console.error('GET /events/:id/ics failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

interface EventReportData {
  event: {
    event_id: string;
    title: string;
    description: string | null;
    location: string | null;
    event_date: Date | string;
    end_date: Date | string | null;
    status: string;
    event_lead_email: string | null;
    mentor_capacity: number | null;
    participant_capacity: number | null;
    capacity: number | null;
    created_at: Date | string;
    updated_at: Date | string;
  };
  assignments: Array<{
    assignment_id: string;
    member_id: string;
    first_name: string;
    last_name: string;
    email: string;
    mobile_phone: string | null;
    role: string;
    assigned_at: Date | string;
    attended: boolean | null;
    attendance_notes: string | null;
  }>;
  responses: Array<{
    response_id: string;
    member_id: string;
    first_name: string;
    last_name: string;
    email: string;
    mobile_phone: string | null;
    response: string;
    response_role: string | null;
    response_channel: string | null;
    responded_at: Date | string;
    notes: string | null;
  }>;
}

function formatContact(email: string | null, mobilePhone: string | null): string {
  return `email: ${email?.trim() || 'n/a'} | phone: ${mobilePhone?.trim() || 'n/a'}`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '""';
  }
  const text = String(value).replace(/"/g, '""');
  return `"${text}"`;
}

function formatReportTimestamp(value: Date | string | null): string {
  if (!value) {
    return '';
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return String(value);
  }
  return parsed.toISOString();
}

function buildEventReportCsv(report: EventReportData): string {
  const lines: string[] = [];

  lines.push('Event Summary');
  lines.push('field,value');
  lines.push(`event_id,${csvCell(report.event.event_id)}`);
  lines.push(`title,${csvCell(report.event.title)}`);
  lines.push(`status,${csvCell(report.event.status)}`);
  lines.push(`event_date,${csvCell(formatReportTimestamp(report.event.event_date))}`);
  lines.push(`end_date,${csvCell(formatReportTimestamp(report.event.end_date))}`);
  lines.push(`location,${csvCell(report.event.location ?? '')}`);
  lines.push(`description,${csvCell(report.event.description ?? '')}`);
  lines.push(`mentor_capacity,${csvCell(report.event.mentor_capacity ?? '')}`);
  lines.push(`participant_capacity,${csvCell(report.event.participant_capacity ?? '')}`);
  lines.push(`capacity,${csvCell(report.event.capacity ?? '')}`);
  lines.push(`created_at,${csvCell(formatReportTimestamp(report.event.created_at))}`);
  lines.push(`updated_at,${csvCell(formatReportTimestamp(report.event.updated_at))}`);
  lines.push('');

  lines.push('Assignments');
  lines.push('assignment_id,member_id,first_name,last_name,email,role,assigned_at,attended,attendance_notes');
  for (const row of report.assignments) {
    lines.push([
      csvCell(row.assignment_id),
      csvCell(row.member_id),
      csvCell(row.first_name),
      csvCell(row.last_name),
      csvCell(row.email),
      csvCell(row.role),
      csvCell(formatReportTimestamp(row.assigned_at)),
      csvCell(row.attended ?? ''),
      csvCell(row.attendance_notes ?? ''),
    ].join(','));
  }
  lines.push('');

  lines.push('RSVP Responses');
  lines.push('response_id,member_id,first_name,last_name,email,response,response_role,response_channel,responded_at,notes');
  for (const row of report.responses) {
    lines.push([
      csvCell(row.response_id),
      csvCell(row.member_id),
      csvCell(row.first_name),
      csvCell(row.last_name),
      csvCell(row.email),
      csvCell(row.response),
      csvCell(row.response_role ?? ''),
      csvCell(row.response_channel ?? ''),
      csvCell(formatReportTimestamp(row.responded_at)),
      csvCell(row.notes ?? ''),
    ].join(','));
  }

  return `${lines.join('\n')}\n`;
}

function buildEventReportText(report: EventReportData): string {
  const yesCount = report.responses.filter((row) => row.response === 'yes').length;
  const maybeCount = report.responses.filter((row) => row.response === 'maybe').length;
  const waitlistCount = report.responses.filter((row) => row.response === 'waitlist').length;
  const noCount = report.responses.filter((row) => row.response === 'no').length;

  const assignmentLines = report.assignments.length === 0
    ? ['- none']
    : report.assignments.map((row) => `- ${row.first_name} ${row.last_name} (${row.role}) | ${formatContact(row.email, row.mobile_phone)} | attended=${row.attended === null ? 'n/a' : String(Boolean(row.attended))}`);

  const responseLines = report.responses.length === 0
    ? ['- none']
    : report.responses.map((row) => `- ${row.first_name} ${row.last_name}: ${row.response}${row.response_role ? ` (${row.response_role})` : ''} | ${formatContact(row.email, row.mobile_phone)}`);

  return [
    `Event Record: ${report.event.title}`,
    `Event ID: ${report.event.event_id}`,
    `Status: ${report.event.status}`,
    `Date: ${formatReportTimestamp(report.event.event_date)}`,
    `End: ${formatReportTimestamp(report.event.end_date) || 'n/a'}`,
    `Location: ${report.event.location ?? 'n/a'}`,
    '',
    'Participation Snapshot',
    `- Assignments: ${report.assignments.length}`,
    `- RSVP Yes: ${yesCount}`,
    `- RSVP Maybe: ${maybeCount}`,
    `- RSVP Waitlist: ${waitlistCount}`,
    `- RSVP No: ${noCount}`,
    '',
    'Assignments',
    ...assignmentLines,
    '',
    'RSVP Responses',
    ...responseLines,
    '',
    `Generated at: ${new Date().toISOString()}`,
  ].join('\n');
}

async function buildEventReportPdf(report: EventReportData): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 48, size: 'LETTER' });
  const chunks: Buffer[] = [];

  doc.on('data', (chunk: Buffer) => chunks.push(chunk));

  doc.fontSize(18).text('PHW Alpine Event Record', { underline: true });
  doc.moveDown(0.6);
  doc.fontSize(11);
  doc.text(`Event: ${report.event.title}`);
  doc.text(`Event ID: ${report.event.event_id}`);
  doc.text(`Status: ${report.event.status}`);
  doc.text(`Date: ${formatReportTimestamp(report.event.event_date)}`);
  doc.text(`End: ${formatReportTimestamp(report.event.end_date) || 'n/a'}`);
  doc.text(`Location: ${report.event.location ?? 'n/a'}`);
  doc.moveDown(0.8);

  doc.fontSize(13).text('Assignments', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10);
  if (report.assignments.length === 0) {
    doc.text('No assignments recorded.');
  } else {
    for (const row of report.assignments) {
      doc.text(`${row.first_name} ${row.last_name} | ${row.role} | attended=${row.attended === null ? 'n/a' : String(Boolean(row.attended))}`);
    }
  }

  doc.moveDown(0.8);
  doc.fontSize(13).text('RSVP Responses', { underline: true });
  doc.moveDown(0.3);
  doc.fontSize(10);
  if (report.responses.length === 0) {
    doc.text('No RSVP responses recorded.');
  } else {
    for (const row of report.responses) {
      doc.text(`${row.first_name} ${row.last_name} | ${row.response}${row.response_role ? ` (${row.response_role})` : ''}`);
    }
  }

  doc.moveDown(0.8);
  doc.fontSize(9).fillColor('#5b6470').text(`Generated at ${new Date().toISOString()}`);
  doc.end();

  return await new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
}

async function loadEventReportData(eventId: string): Promise<EventReportData | null> {
  const pool = await getPool();

  const eventResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .query<EventReportData['event']>(
      `SELECT event_id, title, description, location, event_date, end_date, status,
              ${EVENT_LEAD_EMAIL_SELECT},
              mentor_capacity, participant_capacity, capacity, created_at, updated_at
       FROM event
       WHERE event_id = @event_id`
    );

  const event = eventResult.recordset[0];
  if (!event) {
    return null;
  }

  const assignmentsResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .query<EventReportData['assignments'][number]>(
      `SELECT ea.assignment_id, ea.member_id, m.first_name, m.last_name, m.email, m.mobile_phone,
              ea.role, ea.assigned_at, ea.attended, ea.attendance_notes
       FROM event_assignment ea
       INNER JOIN member m ON m.member_id = ea.member_id
       WHERE ea.event_id = @event_id
       ORDER BY ea.assigned_at ASC`
    );

  const responsesResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .query<EventReportData['responses'][number]>(
      `SELECT er.response_id, er.member_id, m.first_name, m.last_name, m.email, m.mobile_phone,
              er.response, er.response_role, er.response_channel, er.responded_at, er.notes
       FROM event_response er
       INNER JOIN member m ON m.member_id = er.member_id
       WHERE er.event_id = @event_id
       ORDER BY er.responded_at ASC`
    );

  return {
    event,
    assignments: assignmentsResult.recordset,
    responses: responsesResult.recordset,
  };
}

router.get('/:id/report.csv', apiLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const report = await loadEventReportData(req.params.id);
    if (!report) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (report.event.status !== 'completed') {
      res.status(409).json({ error: 'Event report export is available when event status is completed.' });
      return;
    }

    const csv = buildEventReportCsv(report);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="event-report-${report.event.event_id}.csv"`);
    res.status(200).send(csv);
  } catch (error) {
    console.error('GET /events/:id/report.csv failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/report.txt', apiLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const report = await loadEventReportData(req.params.id);
    if (!report) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (report.event.status !== 'completed') {
      res.status(409).json({ error: 'Event report export is available when event status is completed.' });
      return;
    }

    const text = buildEventReportText(report);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="event-report-${report.event.event_id}.txt"`);
    res.status(200).send(text);
  } catch (error) {
    console.error('GET /events/:id/report.txt failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/report.pdf', apiLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const report = await loadEventReportData(req.params.id);
    if (!report) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (report.event.status !== 'completed') {
      res.status(409).json({ error: 'Event report export is available when event status is completed.' });
      return;
    }

    const pdf = await buildEventReportPdf(report);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="event-report-${report.event.event_id}.pdf"`);
    res.status(200).send(pdf);
  } catch (error) {
    console.error('GET /events/:id/report.pdf failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const sendLeadPrepSummary = async (req: Request, res: Response): Promise<void> => {
  try {
    const actor = req.user?.email ?? req.user?.sub ?? 'unknown';
    const actorName = req.user?.name;
    const result = await sendPreEventLeadSummaryEmail({
      eventId: req.params.id,
      actor,
      actorName,
      operationReason: `Manual lead prep summary sent by ${actor}`,
    });

    res.status(200).json({
      event_id: req.params.id,
      to: result.to,
      cc: result.cc,
      sent: 1,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Event not found') {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.message.includes('required before sending')) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('POST /events/:id/lead-summary/email failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

router.post('/:id/lead-summary/email', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  await sendLeadPrepSummary(req, res);
});

router.post('/:id/report/email', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  await sendLeadPrepSummary(req, res);
});

router.post('/:id/participation-summary/email', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const actor = req.user?.email ?? req.user?.sub ?? 'unknown';
    const result = await sendPostEventParticipationSummaryEmail({
      eventId: req.params.id,
      actor,
      operationReason: `Manual participation summary sent by ${actor}`,
    });

    res.status(200).json({
      event_id: req.params.id,
      to: result.to,
      cc: result.cc,
      fallback_used: result.fallbackUsed,
      sent: 1,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Event not found') {
      res.status(404).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.message.includes('must be completed')) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof Error && error.message.includes('required before sending')) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('POST /events/:id/participation-summary/email failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/ai-draft', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const tone = parseAiTone(req.body?.tone);
    const pool = await getPool();
    const eventResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query<{ title: string; event_date: string; location: string | null; description: string | null; event_lead_name: string | null }>(
        `SELECT
           title,
           event_date,
           location,
           description,
           ${EVENT_LEAD_NAME_SELECT}
         FROM event
         WHERE event_id = @event_id`
      );

    const event = eventResult.recordset[0];
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const draft = await generateInviteDraft({
      eventTitle: event.title,
      eventDate: event.event_date,
      location: event.location,
      description: event.description,
      eventLeadName: event.event_lead_name,
      tone,
    });

    res.json({
      ...draft,
      event_id: req.params.id,
      tone,
    });
  } catch (error) {
    console.error('POST /events/:id/ai-draft failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function normalizeString(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  const text = String(value).trim();
  return text.length === 0 ? null : text;
}

function normalizeNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildChangedFieldSummary(
  changedFields: string[],
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string {
  return changedFields
    .map((field) => {
      const label = changedFieldLabel(field);
      const previous = formatChangedFieldValue(field, before[field]);
      const next = formatChangedFieldValue(field, after[field]);
      return `${label}: ${previous} -> ${next}`;
    })
    .join('; ');
}

function changedFieldLabel(field: string): string {
  const labels: Record<string, string> = {
    title: 'Title',
    description: 'Description',
    location: 'Location',
    photo_url: 'Photo URL',
    invitation_stage: 'Invitation stage',
    event_lead_name: 'Event lead name',
    event_lead_email: 'Event lead email',
    event_date: 'Event date/time',
    end_date: 'End time',
    mentor_capacity: 'Volunteer capacity',
    participant_capacity: 'Participant capacity',
    capacity: 'Capacity',
  };

  return labels[field] ?? field;
}

function formatChangedFieldValue(field: string, value: unknown): string {
  if (value === undefined || value === null) {
    return '(empty)';
  }

  if (field === 'event_date' || field === 'end_date') {
    const millis = toUtcMillis(value);
    if (millis === null) {
      return '(invalid date)';
    }
    return new Date(millis).toISOString();
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : '(empty)';
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  return String(value);
}

function parseCapacity(value: unknown): number | null {
  const parsed = normalizeNumber(value);
  if (parsed === null) {
    return null;
  }

  if (!Number.isInteger(parsed) || parsed < 0) {
    return null;
  }

  return parsed;
}

function parsePhotoUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 1024) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

function parseInvitationStage(value: unknown): 'volunteer' | 'participant' | 'both' {
  if (typeof value !== 'string') {
    return 'both';
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'volunteer' || normalized === 'participant' || normalized === 'both') {
    return normalized;
  }

  return 'both';
}

function parseOptionalEmail(value: unknown): string | null {
  const normalized = normalizeString(value);
  if (!normalized) {
    return null;
  }

  // Cap length before regex to prevent ReDoS on pathological inputs.
  const lower = normalized.slice(0, 255).toLowerCase();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(lower)) {
    return null;
  }

  return lower;
}

function parseEventLeadSecondaryRoles(value: unknown): LeadSecondaryRole[] | null {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return null;
  }

  const parsed = new Set<LeadSecondaryRole>();
  for (const item of value) {
    if (typeof item !== 'string') {
      return null;
    }
    const normalized = item.trim().toUpperCase();
    if (normalized !== 'MENTOR' && normalized !== 'PARTICIPANT') {
      return null;
    }
    parsed.add(normalized as LeadSecondaryRole);
  }

  return Array.from(parsed);
}

async function assertEventLeadEligibility(pool: Awaited<ReturnType<typeof getPool>>, memberId: string): Promise<void> {
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query<{ member_id: string }>(
      `SELECT TOP 1 m.member_id
       FROM member m
       WHERE m.member_id = @member_id
         AND m.is_active = 1
         AND (
           EXISTS (
             SELECT 1
             FROM member_group mg
             INNER JOIN [group] g ON g.group_id = mg.group_id
             WHERE mg.member_id = m.member_id
               AND (
                 UPPER(g.group_name) LIKE '%MENTOR%'
                 OR UPPER(g.group_name) LIKE '%VOLUNTEER%'
               )
           )
           OR EXISTS (
             SELECT 1
             FROM event_assignment ea
             WHERE ea.member_id = m.member_id
               AND ea.role = 'MENTOR'
           )
         )`
    );

  if (!result.recordset[0]) {
    throw new HttpError('event_lead_member_id must be an active volunteer-eligible member', 400);
  }
}

async function loadLeadSecondaryRoles(
  pool: Awaited<ReturnType<typeof getPool>>,
  eventId: string,
  memberId: string
): Promise<LeadSecondaryRole[]> {
  const result = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query<{ role: string }>(
      `SELECT role
       FROM event_assignment
       WHERE event_id = @event_id
         AND member_id = @member_id
         AND role IN ('MENTOR', 'PARTICIPANT')`
    );

  const roles = new Set<LeadSecondaryRole>();
  for (const row of result.recordset) {
    if (row.role === 'MENTOR' || row.role === 'PARTICIPANT') {
      roles.add(row.role);
    }
  }
  return Array.from(roles);
}

async function assertLeadSecondaryRoleCapacity(
  pool: Awaited<ReturnType<typeof getPool>>,
  eventId: string,
  leadMemberId: string,
  secondaryRoles: LeadSecondaryRole[],
  capacities: { mentorCapacity: number | null; participantCapacity: number | null }
): Promise<void> {
  const needsMentorCapacity = secondaryRoles.includes('MENTOR') && capacities.mentorCapacity !== null;
  const needsParticipantCapacity = secondaryRoles.includes('PARTICIPANT') && capacities.participantCapacity !== null;

  if (!needsMentorCapacity && !needsParticipantCapacity) {
    return;
  }

  const countsResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .input('lead_member_id', sql.UniqueIdentifier, leadMemberId)
    .query<{ mentor_count: number; participant_count: number }>(
      `SELECT
          SUM(CASE WHEN role = 'MENTOR' THEN 1 ELSE 0 END) AS mentor_count,
          SUM(CASE WHEN role = 'PARTICIPANT' THEN 1 ELSE 0 END) AS participant_count
       FROM event_assignment
       WHERE event_id = @event_id
         AND member_id <> @lead_member_id
         AND role IN ('MENTOR', 'PARTICIPANT')`
    );

  const counts = countsResult.recordset[0] ?? { mentor_count: 0, participant_count: 0 };
  if (needsMentorCapacity && (counts.mentor_count ?? 0) >= (capacities.mentorCapacity as number)) {
    throw new HttpError('Cannot assign event lead as MENTOR because mentor_capacity is full', 409);
  }
  if (needsParticipantCapacity && (counts.participant_count ?? 0) >= (capacities.participantCapacity as number)) {
    throw new HttpError('Cannot assign event lead as PARTICIPANT because participant_capacity is full', 409);
  }
}

async function ensureEventLeadAssignments(
  pool: Awaited<ReturnType<typeof getPool>>,
  eventId: string,
  leadMemberId: string | null,
  secondaryRoles: LeadSecondaryRole[]
): Promise<void> {
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    if (!leadMemberId) {
      await transaction
        .request()
        .input('event_id', sql.UniqueIdentifier, eventId)
        .query(
          `DELETE FROM event_assignment
           WHERE event_id = @event_id
             AND role = 'LEAD'`
        );
      await transaction.commit();
      return;
    }

    await transaction
      .request()
      .input('event_id', sql.UniqueIdentifier, eventId)
      .input('lead_member_id', sql.UniqueIdentifier, leadMemberId)
      .query(
        `DELETE FROM event_assignment
         WHERE event_id = @event_id
           AND role = 'LEAD'
           AND member_id <> @lead_member_id`
      );

    await transaction
      .request()
      .input('event_id', sql.UniqueIdentifier, eventId)
      .input('lead_member_id', sql.UniqueIdentifier, leadMemberId)
      .query(
        `MERGE event_assignment AS target
         USING (SELECT @event_id AS event_id, @lead_member_id AS member_id, 'LEAD' AS role) AS source
         ON target.event_id = source.event_id
            AND target.member_id = source.member_id
            AND target.role = source.role
         WHEN NOT MATCHED THEN
           INSERT (assignment_id, event_id, member_id, role, assigned_at, notes)
           VALUES (NEWID(), source.event_id, source.member_id, source.role, GETUTCDATE(), NULL);`
      );

    const hasMentor = secondaryRoles.includes('MENTOR');
    const hasParticipant = secondaryRoles.includes('PARTICIPANT');

    if (hasMentor) {
      await transaction
        .request()
        .input('event_id', sql.UniqueIdentifier, eventId)
        .input('lead_member_id', sql.UniqueIdentifier, leadMemberId)
        .query(
          `MERGE event_assignment AS target
           USING (SELECT @event_id AS event_id, @lead_member_id AS member_id, 'MENTOR' AS role) AS source
           ON target.event_id = source.event_id
              AND target.member_id = source.member_id
              AND target.role = source.role
           WHEN NOT MATCHED THEN
             INSERT (assignment_id, event_id, member_id, role, assigned_at, notes)
             VALUES (NEWID(), source.event_id, source.member_id, source.role, GETUTCDATE(), NULL);`
        );
    } else {
      await transaction
        .request()
        .input('event_id', sql.UniqueIdentifier, eventId)
        .input('lead_member_id', sql.UniqueIdentifier, leadMemberId)
        .query(
          `DELETE FROM event_assignment
           WHERE event_id = @event_id
             AND member_id = @lead_member_id
             AND role = 'MENTOR'`
        );
    }

    if (hasParticipant) {
      await transaction
        .request()
        .input('event_id', sql.UniqueIdentifier, eventId)
        .input('lead_member_id', sql.UniqueIdentifier, leadMemberId)
        .query(
          `MERGE event_assignment AS target
           USING (SELECT @event_id AS event_id, @lead_member_id AS member_id, 'PARTICIPANT' AS role) AS source
           ON target.event_id = source.event_id
              AND target.member_id = source.member_id
              AND target.role = source.role
           WHEN NOT MATCHED THEN
             INSERT (assignment_id, event_id, member_id, role, assigned_at, notes)
             VALUES (NEWID(), source.event_id, source.member_id, source.role, GETUTCDATE(), NULL);`
        );
    } else {
      await transaction
        .request()
        .input('event_id', sql.UniqueIdentifier, eventId)
        .input('lead_member_id', sql.UniqueIdentifier, leadMemberId)
        .query(
          `DELETE FROM event_assignment
           WHERE event_id = @event_id
             AND member_id = @lead_member_id
             AND role = 'PARTICIPANT'`
        );
    }

    await transaction.commit();
  } catch (error) {
    try {
      await transaction.rollback();
    } catch {
      // Ignore rollback failures; surface original error.
    }
    throw error;
  }
}

function toUtcMillis(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const date = value instanceof Date ? value : new Date(String(value));
  const millis = date.getTime();
  return Number.isNaN(millis) ? null : millis;
}

function formatIcsUtc(date: Date): string {
  const iso = date.toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n/g, '\\n')
    .replace(/\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

function parseEventRole(value: unknown): 'MENTOR' | 'PARTICIPANT' {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return normalized === 'MENTOR' ? 'MENTOR' : 'PARTICIPANT';
}

async function ensureMemberTestAccountColumn(pool: Awaited<ReturnType<typeof getPool>>): Promise<void> {
  await pool.request().query(`
    IF OBJECT_ID(N'dbo.member', N'U') IS NOT NULL
      AND COL_LENGTH(N'dbo.member', N'is_test_account') IS NULL
    BEGIN
      ALTER TABLE dbo.member
      ADD is_test_account BIT NOT NULL CONSTRAINT DF_member_is_test_account DEFAULT(0);
    END
  `);
}

function responseBias(response: string): number {
  if (response === 'yes') {
    return -0.2;
  }
  if (response === 'maybe') {
    return 0;
  }
  return 0.2;
}

router.get('/:id/assignments', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query(
        `SELECT
            ea.assignment_id,
            ea.member_id,
            m.first_name,
            m.last_name,
            ea.role,
            ea.assigned_at,
            ea.attended,
            ea.attendance_notes
         FROM event_assignment ea
         INNER JOIN member m ON m.member_id = ea.member_id
         WHERE ea.event_id = @event_id
         ORDER BY ea.assigned_at ASC`
      );

    res.json(result.recordset);
  } catch (error) {
    console.error('GET /events/:id/assignments failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/assignments', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const memberId = req.body?.member_id as string | undefined;
    const role = (req.body?.role as string | undefined)?.toUpperCase();
    if (!memberId || !role || !['MENTOR', 'PARTICIPANT'].includes(role)) {
      res.status(400).json({ error: 'member_id and role (MENTOR|PARTICIPANT) are required.' });
      return;
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .input('member_id', sql.UniqueIdentifier, memberId)
      .input('role', sql.NVarChar(100), role)
      .query(
        `INSERT INTO event_assignment
           (assignment_id, event_id, member_id, role, assigned_at, notes)
         OUTPUT INSERTED.*
         VALUES (NEWID(), @event_id, @member_id, @role, GETUTCDATE(), NULL)`
      );

    // Send assignment confirmation notification
    const [eventRow, memberRow, rsvpRow] = await Promise.all([
      pool.request()
        .input('event_id', sql.UniqueIdentifier, req.params.id)
        .query<{ title: string; event_date: Date }>('SELECT title, event_date FROM event WHERE event_id = @event_id'),
      pool.request()
        .input('member_id', sql.UniqueIdentifier, memberId)
        .query<{ first_name: string; email: string | null; mobile_phone: string | null; sms_opt_in: boolean }>(
          'SELECT first_name, email, mobile_phone, sms_opt_in FROM member WHERE member_id = @member_id'
        ),
      pool.request()
        .input('event_id', sql.UniqueIdentifier, req.params.id)
        .input('member_id', sql.UniqueIdentifier, memberId)
        .query<{ response: string }>('SELECT TOP 1 response FROM event_response WHERE event_id = @event_id AND member_id = @member_id'),
    ]);

    const event = eventRow.recordset[0];
    const member = memberRow.recordset[0];
    const hadRsvp = (rsvpRow.recordset[0]?.response ?? '') !== '';

    if (event && member) {
      sendAssignmentConfirmation({
        eventId: req.params.id,
        eventTitle: event.title,
        eventDate: formatInProgramTimeZone(event.event_date),
        memberId,
        firstName: member.first_name,
        role,
        recipientEmail: member.email ?? undefined,
        recipientPhone: member.mobile_phone ?? undefined,
        smsOptIn: member.sms_opt_in,
        hadRsvp,
      });
    }

    res.status(201).json(result.recordset[0]);
  } catch (error) {
    console.error('POST /events/:id/assignments failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id/assignments/:assignmentId', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .input('assignment_id', sql.UniqueIdentifier, req.params.assignmentId)
      .query('DELETE FROM event_assignment WHERE event_id = @event_id AND assignment_id = @assignment_id');

    if ((result.rowsAffected[0] ?? 0) === 0) {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }

    res.status(204).send();
  } catch (error) {
    console.error('DELETE /events/:id/assignments/:assignmentId failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/:id/assignments/:assignmentId/attendance', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const attended = req.body?.attended;
    const attendanceNotes = (req.body?.attendance_notes as string | undefined) ?? null;
    if (typeof attended !== 'boolean') {
      res.status(400).json({ error: 'attended boolean is required.' });
      return;
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .input('assignment_id', sql.UniqueIdentifier, req.params.assignmentId)
      .input('attended', sql.Bit, attended ? 1 : 0)
      .input('attendance_notes', sql.NVarChar(500), attendanceNotes)
      .query(
        `UPDATE event_assignment
         SET attended = @attended,
             attendance_notes = @attendance_notes
         OUTPUT INSERTED.*
         WHERE event_id = @event_id
           AND assignment_id = @assignment_id`
      );

    const updated = result.recordset[0];
    if (!updated) {
      res.status(404).json({ error: 'Assignment not found' });
      return;
    }

    res.json(updated);
  } catch (error) {
    console.error('PATCH /events/:id/assignments/:assignmentId/attendance failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/:id/assignment-recommendations', apiLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const role = parseEventRole(req.query.role);
    const rawLimit = Number.parseInt(String(req.query.limit ?? '20'), 10);
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 100)) : 20;

    const pool = await getPool();
    await ensureMemberTestAccountColumn(pool);
    const result = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .input('role', sql.NVarChar, role)
      .input('current_year', sql.Int, new Date().getFullYear())
      .input('prior_year', sql.Int, new Date().getFullYear() - 1)
      .input('limit', sql.Int, limit)
      .query<{
        member_id: string;
        first_name: string;
        last_name: string;
        response: string;
        role_attended_year: number;
        role_attended_prior_year: number;
        total_attended_year: number;
        total_attended_prior_year: number;
      }>(
        `SELECT TOP (@limit)
            er.member_id,
            m.first_name,
            m.last_name,
            er.response,
            SUM(
              CASE
                WHEN YEAR(attendance.event_date) = @current_year
                  THEN CASE
                    WHEN @role = 'PARTICIPANT' AND attendance.participant_attended = 1
                      THEN CASE WHEN attendance.lead_attended = 1 THEN 0.5 ELSE 1 END
                    WHEN @role = 'MENTOR' AND attendance.mentor_attended = 1
                      THEN 1
                    ELSE 0
                  END
                ELSE 0
              END
            ) AS role_attended_year,
            SUM(
              CASE
                WHEN YEAR(attendance.event_date) = @prior_year
                  THEN CASE
                    WHEN @role = 'PARTICIPANT' AND attendance.participant_attended = 1
                      THEN CASE WHEN attendance.lead_attended = 1 THEN 0.5 ELSE 1 END
                    WHEN @role = 'MENTOR' AND attendance.mentor_attended = 1
                      THEN 1
                    ELSE 0
                  END
                ELSE 0
              END
            ) AS role_attended_prior_year,
            SUM(CASE WHEN YEAR(attendance.event_date) = @current_year AND attendance.attended_any = 1 THEN 1 ELSE 0 END) AS total_attended_year,
            SUM(CASE WHEN YEAR(attendance.event_date) = @prior_year AND attendance.attended_any = 1 THEN 1 ELSE 0 END) AS total_attended_prior_year
         FROM event_response er
         INNER JOIN member m ON m.member_id = er.member_id
         LEFT JOIN (
           SELECT
             ea.member_id,
             ea.event_id,
             e_hist.event_date,
             MAX(CASE WHEN ea.attended = 1 THEN 1 ELSE 0 END) AS attended_any,
             MAX(CASE WHEN ea.role = 'LEAD' AND ea.attended = 1 THEN 1 ELSE 0 END) AS lead_attended,
             MAX(CASE WHEN ea.role = 'MENTOR' AND ea.attended = 1 THEN 1 ELSE 0 END) AS mentor_attended,
             MAX(CASE WHEN ea.role = 'PARTICIPANT' AND ea.attended = 1 THEN 1 ELSE 0 END) AS participant_attended
           FROM event_assignment ea
           INNER JOIN event e_hist ON e_hist.event_id = ea.event_id
           WHERE e_hist.status = 'completed'
           GROUP BY ea.member_id, ea.event_id, e_hist.event_date
         ) attendance ON attendance.member_id = er.member_id
         WHERE er.event_id = @event_id
           AND er.response IN ('yes', 'maybe', 'waitlist')
           AND COALESCE(m.is_test_account, 0) = 0
         GROUP BY er.member_id, m.first_name, m.last_name, er.response
         ORDER BY role_attended_year ASC, role_attended_prior_year ASC, total_attended_year ASC, total_attended_prior_year ASC, er.response ASC, m.last_name ASC, m.first_name ASC`
      );

    const rows = result.recordset
      .map((row) => {
        const roleYear = row.role_attended_year ?? 0;
        const rolePrior = row.role_attended_prior_year ?? 0;
        const totalYear = row.total_attended_year ?? 0;
        const totalPrior = row.total_attended_prior_year ?? 0;
        const equityScore = Number((roleYear + rolePrior * 0.6 + totalYear * 0.25 + totalPrior * 0.1 + responseBias(row.response)).toFixed(2));

        return {
          member_id: row.member_id,
          first_name: row.first_name,
          last_name: row.last_name,
          response: row.response,
          suggested_role: role,
          equity_score: equityScore,
          role_attended_year: roleYear,
          role_attended_prior_year: rolePrior,
          total_attended_year: totalYear,
          total_attended_prior_year: totalPrior,
          reason: `${roleYear} ${role.toLowerCase()} shifts this year, ${rolePrior} last year`,
        };
      })
      .sort((a, b) => a.equity_score - b.equity_score);

    res.json({
      event_id: req.params.id,
      role,
      rows: rows.map((row, index) => ({ ...row, rank: index + 1 })),
    });
  } catch (error) {
    console.error('GET /events/:id/assignment-recommendations failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.delete('/:id', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const pool = await getPool();
    const existingResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query<{ status: string }>('SELECT status FROM event WHERE event_id = @event_id');

    const existing = existingResult.recordset[0];
    if (!existing) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (existing.status !== 'draft' && existing.status !== 'cancelled') {
      res.status(409).json({ error: `Cannot delete event in ${existing.status} status. Cancel it first.` });
      return;
    }

    await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query('DELETE FROM event WHERE event_id = @event_id');

    res.status(204).send();
  } catch (error) {
    console.error('DELETE /events/:id failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function cryptoRandomUuid(): string {
  return crypto.randomUUID();
}

function asUuidOrNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidPattern.test(trimmed) ? trimmed : null;
}

export default router;