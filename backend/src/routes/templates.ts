import { Router } from 'express';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/rbac';

const router = Router();

type NotificationChannel = 'email' | 'sms';

interface TemplateRow {
  template_id: string;
  template_name: string;
  channel: NotificationChannel;
  subject: string | null;
  body: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

function parseChannel(value: unknown): NotificationChannel | undefined {
  if (value === 'email' || value === 'sms') {
    return value;
  }
  return undefined;
}

router.get('/', apiLimiter, authenticate, requireAdmin, async (req, res, next) => {
  try {
    const channel = parseChannel(req.query.channel);
    const isActiveRaw = typeof req.query.is_active === 'string' ? req.query.is_active : undefined;
    const isActive = isActiveRaw === undefined ? undefined : isActiveRaw !== 'false';

    const pool = await getPool();
    const request = pool.request();
    const conditions: string[] = [];

    if (channel) {
      request.input('channel', sql.NVarChar(10), channel);
      conditions.push('channel = @channel');
    }

    if (isActive !== undefined) {
      request.input('is_active', sql.Bit, isActive ? 1 : 0);
      conditions.push('is_active = @is_active');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await request.query<TemplateRow>(
      `SELECT template_id, template_name, channel, subject, body, is_active, created_at, updated_at
       FROM notification_template
       ${whereClause}
       ORDER BY template_name ASC, channel ASC`
    );

    res.json(result.recordset.map((row) => ({
      ...row,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    })));
  } catch (error) {
    next(error);
  }
});

router.post('/', writeLimiter, authenticate, requireAdmin, async (req, res, next) => {
  try {
    const templateName = typeof req.body?.template_name === 'string' ? req.body.template_name.trim() : '';
    const channel = parseChannel(req.body?.channel);
    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';

    if (!templateName || !channel || !body) {
      res.status(400).json({ error: 'template_name, channel, and body are required.' });
      return;
    }

    if (channel === 'email' && !subject) {
      res.status(400).json({ error: 'subject is required for email templates.' });
      return;
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input('template_name', sql.NVarChar(100), templateName)
      .input('channel', sql.NVarChar(10), channel)
      .input('subject', sql.NVarChar(300), channel === 'email' ? subject : null)
      .input('body', sql.NVarChar(sql.MAX), body)
      .query<TemplateRow>(
        `INSERT INTO notification_template (template_id, template_name, channel, subject, body, is_active, created_at, updated_at)
         OUTPUT INSERTED.template_id, INSERTED.template_name, INSERTED.channel, INSERTED.subject, INSERTED.body, INSERTED.is_active, INSERTED.created_at, INSERTED.updated_at
         VALUES (NEWID(), @template_name, @channel, @subject, @body, 1, GETUTCDATE(), GETUTCDATE())`
      );

    const row = result.recordset[0];
    res.status(201).json({
      ...row,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  } catch (error: unknown) {
    if (error instanceof Error && /UQ_notification_template_name/i.test(error.message)) {
      res.status(409).json({ error: 'A template with this name and channel already exists.' });
      return;
    }
    next(error);
  }
});

router.patch('/:id', writeLimiter, authenticate, requireAdmin, async (req, res, next) => {
  try {
    const templateId = req.params.id;
    const channel = parseChannel(req.body?.channel);
    const templateName = typeof req.body?.template_name === 'string' ? req.body.template_name.trim() : undefined;
    const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : undefined;
    const body = typeof req.body?.body === 'string' ? req.body.body.trim() : undefined;
    const isActive = typeof req.body?.is_active === 'boolean' ? req.body.is_active : undefined;

    const pool = await getPool();
    const existingResult = await pool
      .request()
      .input('template_id', sql.UniqueIdentifier, templateId)
      .query<TemplateRow>(
        `SELECT template_id, template_name, channel, subject, body, is_active, created_at, updated_at
         FROM notification_template
         WHERE template_id = @template_id`
      );

    const existing = existingResult.recordset[0];
    if (!existing) {
      res.status(404).json({ error: 'Template not found.' });
      return;
    }

    const nextChannel = channel ?? existing.channel;
    const nextTemplateName = templateName ?? existing.template_name;
    const nextBody = body ?? existing.body;
    const nextSubject = nextChannel === 'email'
      ? (subject ?? existing.subject ?? '').trim()
      : null;

    if (!nextTemplateName || !nextBody) {
      res.status(400).json({ error: 'template_name and body cannot be empty.' });
      return;
    }

    if (nextChannel === 'email' && !nextSubject) {
      res.status(400).json({ error: 'subject is required for email templates.' });
      return;
    }

    const updatedResult = await pool
      .request()
      .input('template_id', sql.UniqueIdentifier, templateId)
      .input('template_name', sql.NVarChar(100), nextTemplateName)
      .input('channel', sql.NVarChar(10), nextChannel)
      .input('subject', sql.NVarChar(300), nextSubject)
      .input('body', sql.NVarChar(sql.MAX), nextBody)
      .input('is_active', sql.Bit, (isActive ?? existing.is_active) ? 1 : 0)
      .query<TemplateRow>(
        `UPDATE notification_template
         SET template_name = @template_name,
             channel = @channel,
             subject = @subject,
             body = @body,
             is_active = @is_active,
             updated_at = GETUTCDATE()
         OUTPUT INSERTED.template_id, INSERTED.template_name, INSERTED.channel, INSERTED.subject, INSERTED.body, INSERTED.is_active, INSERTED.created_at, INSERTED.updated_at
         WHERE template_id = @template_id`
      );

    const row = updatedResult.recordset[0];
    res.json({
      ...row,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  } catch (error: unknown) {
    if (error instanceof Error && /UQ_notification_template_name/i.test(error.message)) {
      res.status(409).json({ error: 'A template with this name and channel already exists.' });
      return;
    }
    next(error);
  }
});

router.delete('/:id', writeLimiter, authenticate, requireAdmin, async (req, res, next) => {
  try {
    const templateId = req.params.id;
    const pool = await getPool();
    const result = await pool
      .request()
      .input('template_id', sql.UniqueIdentifier, templateId)
      .query<TemplateRow>(
        `UPDATE notification_template
         SET is_active = 0,
             updated_at = GETUTCDATE()
         OUTPUT INSERTED.template_id, INSERTED.template_name, INSERTED.channel, INSERTED.subject, INSERTED.body, INSERTED.is_active, INSERTED.created_at, INSERTED.updated_at
         WHERE template_id = @template_id`
      );

    const row = result.recordset[0];
    if (!row) {
      res.status(404).json({ error: 'Template not found.' });
      return;
    }

    res.json({
      ...row,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
