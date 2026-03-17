import { Router } from 'express';
import crypto from 'crypto';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAnyAuthenticatedRole, requireEventCreatorOrAdmin } from '../middleware/rbac';
import rsvpRouter from './rsvp';
import {
  sendEventCancelledNotification,
  sendEventPublishedNotification,
} from '../services/notifications';

const router = Router();

const STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['published', 'cancelled'],
  published: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

router.use('/:eventId/rsvp', rsvpRouter);

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
      .query<{ status: string }>('SELECT status FROM event WHERE event_id = @event_id');

    const existing = existingResult.recordset[0];
    if (!existing) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    if (existing.status === 'completed' || existing.status === 'cancelled') {
      res.status(409).json({ error: `Cannot edit event in ${existing.status} status` });
      return;
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

    res.json(updated.recordset[0]);
  } catch (error) {
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
      .query<{ event_id: string; status: string; title: string }>(
        'SELECT event_id, status, title FROM event WHERE event_id = @event_id'
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
      sendEventPublishedNotification({
        eventId: existing.event_id,
        eventTitle: existing.title,
      });
    }
    if (newStatus === 'cancelled') {
      sendEventCancelledNotification({
        eventId: existing.event_id,
        eventTitle: existing.title,
      });
    }

    res.json(updated.recordset[0]);
  } catch (error) {
    console.error('PUT /events/:id/status failed', error);
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