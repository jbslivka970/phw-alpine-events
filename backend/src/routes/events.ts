import { Router, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { AuthenticatedRequest, requireAuth } from '../middleware/auth';
import getPool from '../db';
import {
  sendEventPublishedNotification,
  sendEventCancelledNotification,
} from '../services/notifications';

const router = Router();

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(apiLimiter);

// Valid status transitions
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['PUBLISHED', 'CANCELLED'],
  PUBLISHED: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

// ----------------------------------------------------------------
// GET /events  – list all events (with optional status filter)
// ----------------------------------------------------------------
router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pool = await getPool();
    const { status } = req.query;

    let query = `
      SELECT e.*,
             (SELECT COUNT(*) FROM event_group_target WHERE event_id = e.event_id) AS group_target_count
      FROM [event] e
    `;
    const request = pool.request();
    if (status) {
      query += ` WHERE e.status = @status`;
      request.input('status', status as string);
    }
    query += ` ORDER BY e.event_date DESC`;

    const result = await request.query(query);
    res.json(result.recordset);
  } catch (err) {
    console.error('GET /events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ----------------------------------------------------------------
// GET /events/:id  – get single event with group targets
// ----------------------------------------------------------------
router.get('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pool = await getPool();
    const request = pool.request().input('id', req.params.id);

    const eventResult = await request.query(
      `SELECT * FROM [event] WHERE event_id = @id`
    );
    if (eventResult.recordset.length === 0) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const targetsResult = await pool
      .request()
      .input('id', req.params.id)
      .query(
        `SELECT egt.*, g.name AS group_name
         FROM event_group_target egt
         JOIN [group] g ON g.group_id = egt.group_id
         WHERE egt.event_id = @id`
      );

    res.json({
      ...eventResult.recordset[0],
      group_targets: targetsResult.recordset,
    });
  } catch (err) {
    console.error('GET /events/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ----------------------------------------------------------------
// POST /events  – create event
// ----------------------------------------------------------------
router.post('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const {
    title,
    description,
    event_date,
    location,
    mentor_slots = 0,
    participant_slots = 0,
    group_targets = [],   // array of { group_id, notes }
  } = req.body;

  if (!title || !event_date) {
    res.status(400).json({ error: 'title and event_date are required' });
    return;
  }

  try {
    const pool = await getPool();
    const createdBy = req.user?.email ?? 'unknown';

    const result = await pool
      .request()
      .input('title', title)
      .input('description', description ?? null)
      .input('event_date', event_date)
      .input('location', location ?? null)
      .input('mentor_slots', mentor_slots)
      .input('participant_slots', participant_slots)
      .input('created_by', createdBy)
      .query(`
        INSERT INTO [event]
          (title, description, event_date, location, status, mentor_slots, participant_slots, created_by)
        OUTPUT INSERTED.*
        VALUES (@title, @description, @event_date, @location, 'DRAFT', @mentor_slots, @participant_slots, @created_by)
      `);

    const event = result.recordset[0];

    // Insert group targets if provided
    if (Array.isArray(group_targets) && group_targets.length > 0) {
      for (const gt of group_targets) {
        await pool
          .request()
          .input('event_id', event.event_id)
          .input('group_id', gt.group_id)
          .input('notes', gt.notes ?? null)
          .query(`
            INSERT INTO event_group_target (event_id, group_id, notes)
            VALUES (@event_id, @group_id, @notes)
          `);
      }
    }

    res.status(201).json(event);
  } catch (err) {
    console.error('POST /events error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ----------------------------------------------------------------
// PUT /events/:id  – update event fields (not status)
// ----------------------------------------------------------------
router.put('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const {
    title,
    description,
    event_date,
    location,
    mentor_slots,
    participant_slots,
    group_targets,
  } = req.body;

  try {
    const pool = await getPool();

    // Verify event exists and is editable
    const existing = await pool
      .request()
      .input('id', req.params.id)
      .query(`SELECT status FROM [event] WHERE event_id = @id`);

    if (existing.recordset.length === 0) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }
    if (existing.recordset[0].status === 'CANCELLED' || existing.recordset[0].status === 'COMPLETED') {
      res.status(409).json({ error: `Cannot edit an event in ${existing.recordset[0].status} status` });
      return;
    }

    const updates: string[] = ['updated_at = GETDATE()'];
    const request = pool.request().input('id', req.params.id);

    if (title !== undefined) { updates.push('title = @title'); request.input('title', title); }
    if (description !== undefined) { updates.push('description = @description'); request.input('description', description); }
    if (event_date !== undefined) { updates.push('event_date = @event_date'); request.input('event_date', event_date); }
    if (location !== undefined) { updates.push('location = @location'); request.input('location', location); }
    if (mentor_slots !== undefined) { updates.push('mentor_slots = @mentor_slots'); request.input('mentor_slots', mentor_slots); }
    if (participant_slots !== undefined) { updates.push('participant_slots = @participant_slots'); request.input('participant_slots', participant_slots); }

    const result = await request.query(`
      UPDATE [event] SET ${updates.join(', ')}
      OUTPUT INSERTED.*
      WHERE event_id = @id
    `);

    // Refresh group targets if supplied
    if (Array.isArray(group_targets)) {
      await pool.request().input('id', req.params.id)
        .query(`DELETE FROM event_group_target WHERE event_id = @id`);

      for (const gt of group_targets) {
        await pool
          .request()
          .input('event_id', req.params.id)
          .input('group_id', gt.group_id)
          .input('notes', gt.notes ?? null)
          .query(`
            INSERT INTO event_group_target (event_id, group_id, notes)
            VALUES (@event_id, @group_id, @notes)
          `);
      }
    }

    res.json(result.recordset[0]);
  } catch (err) {
    console.error('PUT /events/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ----------------------------------------------------------------
// PUT /events/:id/status  – transition event status
// ----------------------------------------------------------------
router.put(
  '/:id/status',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    const { status: newStatus } = req.body;
    if (!newStatus) {
      res.status(400).json({ error: 'status is required' });
      return;
    }

    try {
      const pool = await getPool();
      const existing = await pool
        .request()
        .input('id', req.params.id)
        .query(`SELECT event_id, title, status FROM [event] WHERE event_id = @id`);

      if (existing.recordset.length === 0) {
        res.status(404).json({ error: 'Event not found' });
        return;
      }

      const currentStatus: string = existing.recordset[0].status;
      const allowed = ALLOWED_TRANSITIONS[currentStatus] ?? [];

      if (!allowed.includes(newStatus)) {
        res
          .status(409)
          .json({ error: `Cannot transition from ${currentStatus} to ${newStatus}` });
        return;
      }

      const result = await pool
        .request()
        .input('id', req.params.id)
        .input('status', newStatus)
        .query(`
          UPDATE [event] SET status = @status, updated_at = GETDATE()
          OUTPUT INSERTED.*
          WHERE event_id = @id
        `);

      const updatedEvent = result.recordset[0];

      // Fire stub notifications
      if (newStatus === 'PUBLISHED') {
        sendEventPublishedNotification({
          eventId: updatedEvent.event_id,
          eventTitle: updatedEvent.title,
        });
      } else if (newStatus === 'CANCELLED') {
        sendEventCancelledNotification({
          eventId: updatedEvent.event_id,
          eventTitle: updatedEvent.title,
        });
      }

      res.json(updatedEvent);
    } catch (err) {
      console.error('PUT /events/:id/status error:', err);
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// ----------------------------------------------------------------
// DELETE /events/:id  – soft-delete by cancelling (hard delete only for DRAFT)
// ----------------------------------------------------------------
router.delete('/:id', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const pool = await getPool();
    const existing = await pool
      .request()
      .input('id', req.params.id)
      .query(`SELECT status FROM [event] WHERE event_id = @id`);

    if (existing.recordset.length === 0) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const { status } = existing.recordset[0];
    if (status !== 'DRAFT' && status !== 'CANCELLED') {
      res.status(409).json({
        error: `Cannot delete an event in ${status} status. Transition to CANCELLED first.`,
      });
      return;
    }

    await pool
      .request()
      .input('id', req.params.id)
      .query(`DELETE FROM [event] WHERE event_id = @id`);

    res.status(204).send();
  } catch (err) {
    console.error('DELETE /events/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
