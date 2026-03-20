import { Router } from 'express';
import crypto from 'crypto';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAnyAuthenticatedRole, requireEventCreatorOrAdmin } from '../middleware/rbac';
import rsvpRouter from './rsvp';
import {
  assertEventCancelledNotificationReady,
  assertEventPublishedNotificationReady,
  assertEventUpdatedNotificationReady,
  sendEventCancelledNotification,
  sendEventPublishedNotification,
  sendEventUpdatedNotification,
} from '../services/notifications';
import { recordRsvpResponse, RsvpError, VALID_RESPONSES, type RsvpResponse } from '../services/rsvpService';
import { verifyRsvpToken } from '../services/rsvpLinkService';

const router = Router();

const STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['published', 'cancelled'],
  published: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

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
  capacity: number | null;
  status: string;
  member_id: string;
  first_name: string | null;
  current_response: string | null;
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

  const row = result.recordset[0];
  if (!row) {
    return null;
  }

  return {
    ...row,
    token_expires_at: token.expiresAt ?? null,
  };
}

async function submitPublicRsvp(tokenString: string, response: string): Promise<unknown> {
  const token = verifyRsvpToken(tokenString);

  return recordRsvpResponse({
    eventId: token.eventId,
    memberId: token.memberId,
    response: response as RsvpResponse,
    notes: 'Recorded from tokenized RSVP link',
    responseChannel: 'tokenized_link',
    groupContextId: token.groupContextId ?? null,
  });
}

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

    if (!response) {
      res.status(400).json({ error: `response must be one of: ${VALID_RESPONSES.join(', ')}` });
      return;
    }
    if (!VALID_RESPONSES.includes(response as RsvpResponse)) {
      res.status(400).json({ error: `response must be one of: ${VALID_RESPONSES.join(', ')}` });
      return;
    }

    const record = await submitPublicRsvp(getRsvpToken(req), response);

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
    if (!response) {
      res.status(400).json({ error: `response must be one of: ${VALID_RESPONSES.join(', ')}` });
      return;
    }
    if (!VALID_RESPONSES.includes(response as RsvpResponse)) {
      res.status(400).json({ error: `response must be one of: ${VALID_RESPONSES.join(', ')}` });
      return;
    }
    const record = await submitPublicRsvp(req.params.token, response);
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
    const endDate = (req.body?.end_date as string | undefined) ?? null;
    const capacity = typeof req.body?.capacity === 'number' ? req.body.capacity : null;
    const targets = Array.isArray(req.body?.notification_targets) ? req.body.notification_targets : [];
    const createdBy = req.user?.sub ?? null;

    const pool = await getPool();
    const created = await pool
      .request()
      .input('title', sql.NVarChar, title)
      .input('description', sql.NVarChar(sql.MAX), description)
      .input('location', sql.NVarChar, location)
      .input('event_date', sql.DateTime, new Date(eventDate))
      .input('end_date', sql.DateTime, endDate ? new Date(endDate) : null)
      .input('capacity', sql.Int, capacity)
      .input('created_by', sql.UniqueIdentifier, createdBy)
      .query(
        `INSERT INTO event (event_id, title, description, location, event_date, end_date, capacity, status, created_by, created_at, updated_at)
         OUTPUT INSERTED.*
         VALUES (NEWID(), @title, @description, @location, @event_date, @end_date, @capacity, 'draft', @created_by, GETUTCDATE(), GETUTCDATE())`
      );

    const event = created.recordset[0];

    for (const target of targets) {
      if (!target || !target.group_id) {
        continue;
      }
      await pool
        .request()
        .input('target_id', sql.UniqueIdentifier, cryptoRandomUuid())
        .input('event_id', sql.UniqueIdentifier, event.event_id)
        .input('group_id', sql.UniqueIdentifier, target.group_id)
        .query(
          `INSERT INTO event_notification_target (target_id, event_id, group_id, member_id)
           VALUES (@target_id, @event_id, @group_id, NULL)`
        );
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
    const existingResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, req.params.id)
      .query<{
        status: string;
        title: string;
        description: string | null;
        location: string | null;
        event_date: Date | string;
        end_date: Date | string | null;
        capacity: number | null;
      }>(
        'SELECT status, title, description, location, event_date, end_date, capacity FROM event WHERE event_id = @event_id'
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
    const proposedEventDate = req.body?.event_date;
    const proposedEndDate = req.body?.end_date;
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
    if (proposedEventDate !== undefined && toUtcMillis(proposedEventDate) !== toUtcMillis(existing.event_date)) {
      changedFields.push('event_date');
    }
    if (proposedEndDate !== undefined && toUtcMillis(proposedEndDate) !== toUtcMillis(existing.end_date)) {
      changedFields.push('end_date');
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
    if (req.body?.event_date !== undefined) {
      updates.push('event_date = @event_date');
      request.input('event_date', sql.DateTime, new Date(req.body.event_date));
    }
    if (req.body?.end_date !== undefined) {
      updates.push('end_date = @end_date');
      request.input('end_date', sql.DateTime, req.body.end_date ? new Date(req.body.end_date) : null);
    }
    if (req.body?.capacity !== undefined) {
      updates.push('capacity = @capacity');
      request.input('capacity', sql.Int, req.body.capacity);
    }

    if (existing.status === 'published' && changedFields.length > 0) {
      await assertEventUpdatedNotificationReady(req.params.id);
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
      await sendEventUpdatedNotification({
        event_id: req.params.id,
        title: updated.recordset[0].title,
        event_date: updated.recordset[0].event_date,
        location: updated.recordset[0].location,
        description: updated.recordset[0].description,
        changedFields,
        updateReason: (req.body?.update_reason as string | undefined) ?? (req.body?.reason as string | undefined) ?? null,
      });
    }

    res.json(updated.recordset[0]);
  } catch (error) {
    if (isNotificationConfigurationError(error)) {
      res.status(503).json({ error: error.message });
      return;
    }

    console.error('PUT /events/:id failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/:id/status', writeLimiter, authenticate, requireEventCreatorOrAdmin, async (req, res) => {
  try {
    const newStatus = (req.body?.status as string | undefined)?.toLowerCase();
    if (!newStatus) {
      res.status(400).json({ error: 'status is required' });
      return;
    }

    const pool = await getPool();
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
      }>(
        'SELECT event_id, status, title, event_date, location, description FROM event WHERE event_id = @event_id'
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

    if (newStatus === 'published') {
      await assertEventPublishedNotificationReady(req.params.id);
    }
    if (newStatus === 'cancelled') {
      await assertEventCancelledNotificationReady(req.params.id);
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
      await sendEventPublishedNotification({
        event_id: existing.event_id,
        title: existing.title,
        event_date: existing.event_date,
        location: existing.location,
        description: existing.description,
      });
    }
    if (newStatus === 'cancelled') {
      await sendEventCancelledNotification({
        event_id: existing.event_id,
        title: existing.title,
        event_date: existing.event_date,
        location: existing.location,
        description: existing.description,
        updateReason: (req.body?.reason as string | undefined) ?? (req.body?.cancellation_reason as string | undefined) ?? null,
      });
    }

    res.json(updated.recordset[0]);
  } catch (error) {
    if (isNotificationConfigurationError(error)) {
      res.status(503).json({ error: error.message });
      return;
    }

    console.error('PUT /events/:id/status failed', error);
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

function toUtcMillis(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const date = value instanceof Date ? value : new Date(String(value));
  const millis = date.getTime();
  return Number.isNaN(millis) ? null : millis;
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

export default router;