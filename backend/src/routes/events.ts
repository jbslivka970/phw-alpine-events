import { Router } from 'express';
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
  sendEventCancelledNotification,
  sendEventCompletedNotification,
  sendEventPublishedNotification,
  sendEventUpdatedNotification,
} from '../services/notifications';
import { inferResponseRoleForMember, recordRsvpResponse, RsvpError, VALID_RESPONSES, type RsvpResponse } from '../services/rsvpService';
import { verifyRsvpToken } from '../services/rsvpLinkService';
import { generateInviteDraft } from '../services/aiInviteService';

const router = Router();

const STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['published', 'cancelled'],
  published: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

type EventColumnSupport = {
  hasEventLeadName: boolean;
  hasEventLeadEmail: boolean;
  hasPhotoUrl: boolean;
  hasInvitationStage: boolean;
};

let cachedEventColumnSupport: EventColumnSupport | null = null;

async function getEventColumnSupport(pool: Awaited<ReturnType<typeof getPool>>): Promise<EventColumnSupport> {
  if (cachedEventColumnSupport) {
    return cachedEventColumnSupport;
  }

  const result = await pool
    .request()
    .query<{ has_event_lead_name: number; has_event_lead_email: number; has_photo_url: number; has_invitation_stage: number }>(
      `SELECT
         CASE WHEN COL_LENGTH('dbo.event', 'event_lead_name') IS NULL THEN 0 ELSE 1 END AS has_event_lead_name,
         CASE WHEN COL_LENGTH('dbo.event', 'event_lead_email') IS NULL THEN 0 ELSE 1 END AS has_event_lead_email,
         CASE WHEN COL_LENGTH('dbo.event', 'photo_url') IS NULL THEN 0 ELSE 1 END AS has_photo_url,
         CASE WHEN COL_LENGTH('dbo.event', 'invitation_stage') IS NULL THEN 0 ELSE 1 END AS has_invitation_stage`
    );

  const row = result.recordset[0];
  cachedEventColumnSupport = {
    hasEventLeadName: row?.has_event_lead_name === 1,
    hasEventLeadEmail: row?.has_event_lead_email === 1,
    hasPhotoUrl: row?.has_photo_url === 1,
    hasInvitationStage: row?.has_invitation_stage === 1,
  };

  return cachedEventColumnSupport;
}

function isNotificationConfigurationError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'NotificationConfigurationError';
}

router.use('/:eventId/rsvp', rsvpRouter);

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

  return recordRsvpResponse({
    eventId: token.eventId,
    memberId: token.memberId,
    response: response as RsvpResponse,
    notes: 'Recorded from tokenized RSVP link',
    responseChannel: 'tokenized_link',
    groupContextId: token.groupContextId ?? null,
    responseRole,
  });
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

function renderRsvpActionHtml(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: 'Segoe UI', Arial, sans-serif; margin: 0; padding: 24px; background: #f4f7f9; color: #1f2937; }
      .card { max-width: 640px; margin: 0 auto; background: #fff; border: 1px solid #dbe3ea; border-radius: 10px; padding: 20px; box-shadow: 0 6px 18px rgba(12, 28, 43, 0.08); }
      h1 { margin: 0 0 8px; font-size: 1.35rem; }
      p { margin: 0; line-height: 1.45; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${title}</h1>
      <p>${body}</p>
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

    let query = `
      SELECT e.*,
             (SELECT COUNT(*) FROM event_response er WHERE er.event_id = e.event_id AND er.response = 'yes') AS yes_count,
             (SELECT COUNT(*) FROM event_notification_target ent WHERE ent.event_id = e.event_id) AS target_count
      FROM event e
    `;

    const request = pool.request();
    if (status) {
      query += ' WHERE e.status = @status';
      request.input('status', sql.NVarChar, status);
    }
    query += ' ORDER BY e.event_date DESC';

    const result = await request.query(query);
    res.json(result.recordset);
  } catch (error) {
    console.error('GET /events failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/ai-draft-preview', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const tone = (req.body?.tone as string | undefined)?.toLowerCase() === 'professional' ? 'professional' : 'friendly';
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const eventDate = typeof req.body?.event_date === 'string' ? req.body.event_date.trim() : '';
    const location = typeof req.body?.location === 'string' ? req.body.location.trim() : null;
    const description = typeof req.body?.description === 'string' ? req.body.description.trim() : null;

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

router.get('/:id', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req, res) => {
  try {
    const pool = await getPool();
    const eventResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query('SELECT * FROM event WHERE event_id = @event_id');

    const event = eventResult.recordset[0];
    if (!event) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const targets = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query(
        `SELECT ent.target_id, ent.event_id, ent.group_id, ent.member_id, g.group_name
         FROM event_notification_target ent
         LEFT JOIN [group] g ON g.group_id = ent.group_id
         WHERE ent.event_id = @event_id`
      );

    res.json({ ...event, notification_targets: targets.recordset });
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
    const eventLeadName = normalizeString(req.body?.event_lead_name);
    if (req.body?.event_lead_email !== undefined && normalizeString(req.body?.event_lead_email) && !parseOptionalEmail(req.body?.event_lead_email)) {
      res.status(400).json({ error: 'event_lead_email must be a valid email address when provided' });
      return;
    }
    const eventLeadEmail = parseOptionalEmail(req.body?.event_lead_email);
    const endDate = (req.body?.end_date as string | undefined) ?? null;
    const mentorCapacity = parseCapacity(req.body?.mentor_capacity);
    const participantCapacity = parseCapacity(req.body?.participant_capacity);
    const legacyCapacity = parseCapacity(req.body?.capacity);
    const computedCapacity = (mentorCapacity ?? 0) + (participantCapacity ?? 0);
    const capacity = computedCapacity > 0 ? computedCapacity : legacyCapacity;
    const rawTargets = Array.isArray(req.body?.notification_targets) ? req.body.notification_targets : [];
    const createdBy = null;

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

    if (eventColumns.hasEventLeadName) {
      insertColumns.splice(6, 0, 'event_lead_name');
      insertValues.splice(6, 0, '@event_lead_name');
      createRequest.input('event_lead_name', sql.NVarChar(200), eventLeadName);
    }
    if (eventColumns.hasEventLeadEmail) {
      const insertIndex = eventColumns.hasEventLeadName ? 7 : 6;
      insertColumns.splice(insertIndex, 0, 'event_lead_email');
      insertValues.splice(insertIndex, 0, '@event_lead_email');
      createRequest.input('event_lead_email', sql.NVarChar(255), eventLeadEmail);
    }

    const created = await createRequest.query(
      `INSERT INTO event (${insertColumns.join(', ')})
       OUTPUT INSERTED.*
       VALUES (${insertValues.join(', ')})`
    );

    const event = created.recordset[0];

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

    res.status(201).json(event);
  } catch (error) {
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
           ${eventColumns.hasEventLeadName ? 'event_lead_name' : 'CAST(NULL AS NVARCHAR(200)) AS event_lead_name'},
           ${eventColumns.hasEventLeadEmail ? 'event_lead_email' : 'CAST(NULL AS NVARCHAR(255)) AS event_lead_email'},
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
    const proposedEventLeadName = req.body?.event_lead_name;
    const proposedEventLeadEmail = req.body?.event_lead_email;
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
    if (eventColumns.hasEventLeadName && proposedEventLeadName !== undefined && normalizeString(proposedEventLeadName) !== normalizeString(existing.event_lead_name)) {
      changedFields.push('event_lead_name');
    }
    if (eventColumns.hasEventLeadEmail && proposedEventLeadEmail !== undefined && normalizeString(proposedEventLeadEmail) !== normalizeString(existing.event_lead_email)) {
      changedFields.push('event_lead_email');
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
    if (eventColumns.hasEventLeadName && req.body?.event_lead_name !== undefined) {
      updates.push('event_lead_name = @event_lead_name');
      request.input('event_lead_name', sql.NVarChar(200), normalizeString(req.body.event_lead_name));
    }
    if (eventColumns.hasEventLeadEmail && req.body?.event_lead_email !== undefined) {
      if (normalizeString(req.body?.event_lead_email) && !parseOptionalEmail(req.body?.event_lead_email)) {
        res.status(400).json({ error: 'event_lead_email must be a valid email address when provided' });
        return;
      }
      updates.push('event_lead_email = @event_lead_email');
      request.input('event_lead_email', sql.NVarChar(255), parseOptionalEmail(req.body.event_lead_email));
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

    let notificationWarning: string | null = null;

    if (existing.status === 'published' && changedFields.length > 0) {
      try {
        await assertEventUpdatedNotificationReady(req.params.id);
      } catch (error) {
        if (isNotificationConfigurationError(error)) {
          throw error;
        }
        notificationWarning = 'Event updated, but notification readiness checks failed.';
        console.error('PUT /events/:id update notification readiness check failed', error);
      }
    }

    const updated = await request.query(
      `UPDATE event SET ${updates.join(', ')}
       OUTPUT INSERTED.*
       WHERE event_id = @event_id`
    );

    if (Array.isArray(req.body?.notification_targets)) {
      await pool
        .request()
        .input('event_id', sql.UniqueIdentifier, req.params.id)
        .query('DELETE FROM event_notification_target WHERE event_id = @event_id');

      for (const target of req.body.notification_targets) {
        if (!target || !target.group_id) {
          continue;
        }

        await pool
          .request()
          .input('target_id', sql.UniqueIdentifier, cryptoRandomUuid())
          .input('event_id', sql.UniqueIdentifier, req.params.id)
          .input('group_id', sql.UniqueIdentifier, target.group_id)
          .query(
            `INSERT INTO event_notification_target (target_id, event_id, group_id, member_id)
             VALUES (@target_id, @event_id, @group_id, NULL)`
          );
      }
    }

    if (existing.status === 'published' && changedFields.length > 0) {
      if (changedFields.includes('invitation_stage')) {
        try {
          await sendEventPublishedNotification({
            event_id: req.params.id,
            title: updated.recordset[0].title,
            event_date: updated.recordset[0].event_date,
            location: updated.recordset[0].location,
            description: updated.recordset[0].description,
            photo_url: updated.recordset[0].photo_url,
            invitation_stage: updated.recordset[0].invitation_stage,
            event_lead_name: updated.recordset[0].event_lead_name,
            event_lead_email: updated.recordset[0].event_lead_email,
          });
        } catch (error) {
          if (isNotificationConfigurationError(error)) {
            throw error;
          }
          notificationWarning = 'Event updated, but republish notifications failed.';
          console.error('PUT /events/:id republish notification failed', error);
        }
      }

      const updateChangedFields = changedFields.filter((field) => field !== 'invitation_stage');
      if (updateChangedFields.length === 0) {
        res.json({
          ...updated.recordset[0],
          ...(notificationWarning ? { notification_warning: notificationWarning } : {}),
        });
        return;
      }

      const changeSummary = buildChangedFieldSummary(updateChangedFields, existing, updated.recordset[0]);
      try {
        await sendEventUpdatedNotification({
          event_id: req.params.id,
          title: updated.recordset[0].title,
          event_date: updated.recordset[0].event_date,
          location: updated.recordset[0].location,
          description: updated.recordset[0].description,
          photo_url: updated.recordset[0].photo_url,
          invitation_stage: updated.recordset[0].invitation_stage,
          event_lead_name: updated.recordset[0].event_lead_name,
          event_lead_email: updated.recordset[0].event_lead_email,
          changedFields: updateChangedFields,
          changeSummary,
          updateReason: (req.body?.update_reason as string | undefined) ?? (req.body?.reason as string | undefined) ?? null,
        });
      } catch (error) {
        if (isNotificationConfigurationError(error)) {
          throw error;
        }
        notificationWarning = 'Event updated, but attendee update notifications failed.';
        console.error('PUT /events/:id update notification send failed', error);
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

    console.error('PUT /events/:id failed', error);
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
           ${eventColumns.hasEventLeadName ? 'event_lead_name' : 'CAST(NULL AS NVARCHAR(200)) AS event_lead_name'},
           ${eventColumns.hasEventLeadEmail ? 'event_lead_email' : 'CAST(NULL AS NVARCHAR(255)) AS event_lead_email'}
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
      try {
        await sendEventPublishedNotification({
          event_id: existing.event_id,
          title: existing.title,
          event_date: existing.event_date,
          location: existing.location,
          description: existing.description,
          invitation_stage: existing.invitation_stage ?? 'both',
          event_lead_name: existing.event_lead_name,
          event_lead_email: existing.event_lead_email,
        });
      } catch (error) {
        if (isNotificationConfigurationError(error)) {
          throw error;
        }
        notificationWarning = 'Event status changed, but publish notifications failed.';
        console.error('PUT /events/:id/status publish notification failed', error);
      }
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
    response: string;
    response_role: string | null;
    response_channel: string | null;
    responded_at: Date | string;
    notes: string | null;
  }>;
}

function parseRecipientList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((value) => (typeof value === 'string' ? value.trim().toLowerCase() : ''))
      .filter((value) => value.length > 0);
  }

  if (typeof raw !== 'string') {
    return [];
  }

  return raw
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
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
    : report.assignments.map((row) => `- ${row.first_name} ${row.last_name} (${row.role}) attended=${row.attended === null ? 'n/a' : String(Boolean(row.attended))}`);

  const responseLines = report.responses.length === 0
    ? ['- none']
    : report.responses.map((row) => `- ${row.first_name} ${row.last_name}: ${row.response}${row.response_role ? ` (${row.response_role})` : ''}`);

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
      `SELECT ea.assignment_id, ea.member_id, m.first_name, m.last_name, m.email,
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
      `SELECT er.response_id, er.member_id, m.first_name, m.last_name, m.email,
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

router.post('/:id/report/email', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const report = await loadEventReportData(req.params.id);
    if (!report) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (report.event.status !== 'completed') {
      res.status(409).json({ error: 'Event report email is available when event status is completed.' });
      return;
    }

    const envRecipients = parseRecipientList(process.env['EVENT_RECORD_EMAIL_TO'] ?? process.env['ACS_EMAIL_TO']);
    const bodyRecipients = parseRecipientList(req.body?.recipients);
    const recipients = bodyRecipients.length > 0 ? bodyRecipients : envRecipients;

    if (recipients.length === 0) {
      res.status(400).json({ error: 'No recipients configured. Provide recipients or set EVENT_RECORD_EMAIL_TO.' });
      return;
    }

    const reportText = buildEventReportText(report);
    const actor = req.user?.email ?? req.user?.sub ?? 'unknown';
    const subject = `Completed Event Record: ${report.event.title}`;
    const htmlBody = `<p>Completed event record generated by ${actor}.</p><pre>${reportText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')}</pre>`;

    for (const recipient of recipients) {
      await notificationService.sendEmail({
        to: recipient,
        subject,
        htmlBody,
        textBody: reportText,
        eventId: report.event.event_id,
        operationType: 'event_record_email',
        operationReason: `Sent by ${actor}`,
      });
    }

    res.status(200).json({
      event_id: report.event.event_id,
      recipients,
      sent: recipients.length,
    });
  } catch (error) {
    console.error('POST /events/:id/report/email failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/:id/ai-draft', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const tone = (req.body?.tone as string | undefined)?.toLowerCase() === 'professional' ? 'professional' : 'friendly';
    const pool = await getPool();
    const eventResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query<{ title: string; event_date: string; location: string | null; description: string | null }>(
        'SELECT title, event_date, location, description FROM event WHERE event_id = @event_id'
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

  if (!Number.isInteger(parsed) || parsed < 1) {
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

  const lower = normalized.toLowerCase();
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(lower)) {
    return null;
  }

  return lower;
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
            SUM(CASE WHEN YEAR(e_hist.event_date) = @current_year AND ea.role = @role AND ea.attended = 1 THEN 1 ELSE 0 END) AS role_attended_year,
            SUM(CASE WHEN YEAR(e_hist.event_date) = @prior_year AND ea.role = @role AND ea.attended = 1 THEN 1 ELSE 0 END) AS role_attended_prior_year,
            SUM(CASE WHEN YEAR(e_hist.event_date) = @current_year AND ea.attended = 1 THEN 1 ELSE 0 END) AS total_attended_year,
            SUM(CASE WHEN YEAR(e_hist.event_date) = @prior_year AND ea.attended = 1 THEN 1 ELSE 0 END) AS total_attended_prior_year
         FROM event_response er
         INNER JOIN member m ON m.member_id = er.member_id
         LEFT JOIN event_assignment ea ON ea.member_id = er.member_id
         LEFT JOIN event e_hist ON e_hist.event_id = ea.event_id AND e_hist.status = 'completed'
         WHERE er.event_id = @event_id
           AND er.response IN ('yes', 'maybe', 'waitlist')
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