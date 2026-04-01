import { Router } from 'express';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/rbac';
import { generateInviteDraft } from '../services/aiInviteService';
import { runRetentionJob } from '../jobs/retentionJob';

const router = Router();

type InviteTone = 'friendly' | 'professional';

interface InviteDraftRequestBody {
  event_id?: string;
  title?: string;
  event_date?: string;
  location?: string | null;
  description?: string | null;
  tone?: string;
}

interface RetentionPreviewRequestBody {
  notification_log_days?: number;
  inbound_sms_log_days?: number;
  email_preference_log_days?: number;
  format?: 'json' | 'csv';
}

router.use(apiLimiter, authenticate, requireAdmin);

router.get('/users', async (req, res) => {
  try {
    const page = parsePositiveInt(req.query.page as string | undefined, 1);
    const pageSize = Math.min(parsePositiveInt(req.query.pageSize as string | undefined, 50), 200);
    const offset = (page - 1) * pageSize;
    const search = (req.query.search as string | undefined)?.trim();
    const role = (req.query.role as string | undefined)?.toLowerCase();
    const isActiveRaw = (req.query.isActive as string | undefined)?.toLowerCase();
    const isActive = isActiveRaw === undefined
      ? undefined
      : (isActiveRaw === 'true' || isActiveRaw === '1');

    if (role && !['admin', 'superadmin'].includes(role)) {
      res.status(400).json({ error: 'role must be admin or superadmin' });
      return;
    }

    const pool = await getPool();
    const whereClauses: string[] = [];

    const applyFilters = (request: sql.Request): sql.Request => {
      if (search) {
        whereClauses.push('(email LIKE @search OR display_name LIKE @search)');
        request.input('search', sql.NVarChar, `%${search}%`);
      }
      if (role) {
        whereClauses.push('role = @role');
        request.input('role', sql.NVarChar(20), role);
      }
      if (isActive !== undefined) {
        whereClauses.push('is_active = @is_active');
        request.input('is_active', sql.Bit, isActive ? 1 : 0);
      }
      return request;
    };

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const listRequest = applyFilters(pool.request())
      .input('offset', sql.Int, offset)
      .input('pageSize', sql.Int, pageSize);
    const countRequest = applyFilters(pool.request());

    const [listResult, countResult] = await Promise.all([
      listRequest.query(
        `SELECT user_id, azure_oid, email, display_name, role, is_active, last_login, created_at, updated_at
         FROM [user]
         ${whereSql}
         ORDER BY created_at DESC
         OFFSET @offset ROWS FETCH NEXT @pageSize ROWS ONLY`
      ),
      countRequest.query(`SELECT COUNT(*) AS total FROM [user] ${whereSql}`),
    ]);

    res.json({
      data: listResult.recordset,
      total: countResult.recordset[0]?.total ?? 0,
      page,
      pageSize,
    });
  } catch (error) {
    console.error('GET /admin/users failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/users', writeLimiter, async (req, res) => {
  try {
    const email = (req.body?.email as string | undefined)?.trim().toLowerCase();
    const displayName = (req.body?.display_name as string | undefined)?.trim() ?? null;
    const role = ((req.body?.role as string | undefined) ?? 'admin').toLowerCase();
    const azureOid = (req.body?.azure_oid as string | undefined)?.trim() ?? null;

    if (!email) {
      res.status(400).json({ error: 'email is required' });
      return;
    }
    if (!['admin', 'superadmin'].includes(role)) {
      res.status(400).json({ error: 'role must be admin or superadmin' });
      return;
    }

    const pool = await getPool();
    const existing = await pool
      .request()
      .input('email', sql.NVarChar(255), email)
      .query<{ user_id: string }>('SELECT user_id FROM [user] WHERE email = @email');

    if (existing.recordset[0]) {
      res.status(409).json({ error: 'A user with that email already exists.' });
      return;
    }

    const created = await pool
      .request()
      .input('email', sql.NVarChar(255), email)
      .input('display_name', sql.NVarChar(200), displayName)
      .input('role', sql.NVarChar(20), role)
      .input('azure_oid', sql.NVarChar(255), azureOid)
      .query(
        `INSERT INTO [user] (user_id, azure_oid, email, display_name, role, is_active, created_at, updated_at)
         OUTPUT INSERTED.user_id, INSERTED.azure_oid, INSERTED.email, INSERTED.display_name, INSERTED.role, INSERTED.is_active, INSERTED.last_login, INSERTED.created_at, INSERTED.updated_at
         VALUES (NEWID(), @azure_oid, @email, @display_name, @role, 1, GETUTCDATE(), GETUTCDATE())`
      );

    res.status(201).json(created.recordset[0]);
  } catch (error) {
    console.error('POST /admin/users failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.patch('/users/:id', writeLimiter, async (req, res) => {
  try {
    const role = (req.body?.role as string | undefined)?.toLowerCase();
    const displayName = req.body?.display_name;
    const isActive = req.body?.is_active;
    const azureOid = req.body?.azure_oid;

    if (role !== undefined && !['admin', 'superadmin'].includes(role)) {
      res.status(400).json({ error: 'role must be admin or superadmin' });
      return;
    }
    if (
      displayName !== undefined &&
      displayName !== null &&
      typeof displayName !== 'string'
    ) {
      res.status(400).json({ error: 'display_name must be a string or null' });
      return;
    }
    if (isActive !== undefined && typeof isActive !== 'boolean') {
      res.status(400).json({ error: 'is_active must be a boolean' });
      return;
    }
    if (azureOid !== undefined && azureOid !== null && typeof azureOid !== 'string') {
      res.status(400).json({ error: 'azure_oid must be a string or null' });
      return;
    }

    const updates: string[] = [];
    const request = (await getPool()).request().input('user_id', sql.UniqueIdentifier, req.params.id);

    if (role !== undefined) {
      updates.push('role = @role');
      request.input('role', sql.NVarChar(20), role);
    }
    if (displayName !== undefined) {
      updates.push('display_name = @display_name');
      request.input('display_name', sql.NVarChar(200), displayName);
    }
    if (isActive !== undefined) {
      updates.push('is_active = @is_active');
      request.input('is_active', sql.Bit, isActive ? 1 : 0);
    }
    if (azureOid !== undefined) {
      updates.push('azure_oid = @azure_oid');
      request.input('azure_oid', sql.NVarChar(255), azureOid);
    }

    if (updates.length === 0) {
      res.status(400).json({ error: 'No valid fields provided for update.' });
      return;
    }

    const updated = await request.query(
      `UPDATE [user]
       SET ${updates.join(', ')},
           updated_at = GETUTCDATE()
       OUTPUT INSERTED.user_id, INSERTED.azure_oid, INSERTED.email, INSERTED.display_name, INSERTED.role, INSERTED.is_active, INSERTED.last_login, INSERTED.created_at, INSERTED.updated_at
       WHERE user_id = @user_id`
    );

    const user = updated.recordset[0];
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    res.json(user);
  } catch (error) {
    console.error('PATCH /admin/users/:id failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/import', writeLimiter, async (req, res) => {
  try {
    const importId = (req.body?.import_id as string | undefined)?.trim();
    if (!importId) {
      res.status(400).json({ error: 'import_id is required' });
      return;
    }

    const pool = await getPool();
    const result = await pool
      .request()
      .input('import_id', sql.UniqueIdentifier, importId)
      .query(
        `SELECT import_id, file_name, rows_processed, rows_inserted, rows_updated, rows_skipped,
                rows_errored, status, error_detail, started_at, completed_at
         FROM import_log
         WHERE import_id = @import_id`
      );

    const snapshot = result.recordset[0];
    if (!snapshot) {
      res.status(404).json({ error: 'Import run not found.' });
      return;
    }

    res.status(200).json(snapshot);
  } catch (error) {
    console.error('POST /admin/import failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/ai/invite-draft', writeLimiter, async (req, res) => {
  try {
    const { draft, source, tone } = await resolveInviteDraftRequest(req.body as InviteDraftRequestBody);

    res.json({
      ...draft,
      source,
      tone,
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'Event not found.') {
        res.status(404).json({ error: 'Event not found.' });
        return;
      }
      if (error.message.includes('title and event_date are required')) {
        res.status(400).json({ error: 'title and event_date are required (or provide event_id).' });
        return;
      }
    }
    console.error('POST /admin/ai/invite-draft failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/ai/invite-draft/apply', writeLimiter, async (req, res) => {
  try {
    const approved = req.body?.approved === true;
    if (!approved) {
      res.status(400).json({ error: 'approved must be true to apply invite draft templates.' });
      return;
    }

    const templateNameRaw = (req.body?.template_name as string | undefined)?.trim();
    const templateName = templateNameRaw && templateNameRaw.length > 0 ? templateNameRaw : 'Event Invite';
    const reviewNoteRaw = (req.body?.review_note as string | undefined)?.trim();
    const reviewNote = reviewNoteRaw && reviewNoteRaw.length > 0 ? reviewNoteRaw.slice(0, 500) : null;

    const { draft, source, tone } = await resolveInviteDraftRequest(req.body as InviteDraftRequestBody);
    const pool = await getPool();

    const [emailTemplate, smsTemplate] = await Promise.all([
      upsertNotificationTemplate(pool, {
        templateName,
        channel: 'email',
        subject: draft.subject,
        body: draft.emailBody,
      }),
      upsertNotificationTemplate(pool, {
        templateName,
        channel: 'sms',
        subject: null,
        body: draft.smsBody,
      }),
    ]);

    const appliedBy = req.user?.email ?? req.user?.sub ?? 'unknown';
    console.log(JSON.stringify({
      level: 'info',
      event: 'admin_ai_invite_template_applied',
      templateName,
      source,
      tone,
      provider: draft.provider,
      approved,
      reviewNote,
      appliedBy,
      appliedAt: new Date().toISOString(),
    }));

    res.status(200).json({
      template_name: templateName,
      source,
      tone,
      provider: draft.provider,
      approved,
      review_note: reviewNote,
      applied_by: appliedBy,
      applied_at: new Date().toISOString(),
      templates: {
        email: {
          template_id: emailTemplate.template_id,
          updated_at: emailTemplate.updated_at.toISOString(),
        },
        sms: {
          template_id: smsTemplate.template_id,
          updated_at: smsTemplate.updated_at.toISOString(),
        },
      },
    });
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'Event not found.') {
        res.status(404).json({ error: 'Event not found.' });
        return;
      }
      if (error.message.includes('title and event_date are required')) {
        res.status(400).json({ error: 'title and event_date are required (or provide event_id).' });
        return;
      }
    }
    console.error('POST /admin/ai/invite-draft/apply failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/retention/preview', async (req, res) => {
  try {
    const body = (req.body ?? {}) as RetentionPreviewRequestBody;
    const notificationLogDays = parseOptionalPositiveInt(body.notification_log_days);
    const inboundSmsLogDays = parseOptionalPositiveInt(body.inbound_sms_log_days);
    const emailPreferenceLogDays = parseOptionalPositiveInt(body.email_preference_log_days);
    const format = body.format === 'csv' ? 'csv' : 'json';

    const results = await runRetentionJob({
      dryRun: true,
      notificationLogDays,
      inboundSmsLogDays,
      emailPreferenceLogDays,
    });

    const generatedAt = new Date().toISOString();
    const generatedBy = req.user?.email ?? req.user?.sub ?? 'unknown';

    if (format === 'csv') {
      const csvLines = [
        'target,retention_days,candidate_rows,mode,generated_at,generated_by',
        ...results.map((row) => {
          return [
            row.target,
            String(row.retentionDays),
            String(row.affectedRows),
            row.mode,
            generatedAt,
            generatedBy,
          ].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(',');
        }),
      ];

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.status(200).send(csvLines.join('\n'));
      return;
    }

    res.status(200).json({
      generated_at: generatedAt,
      generated_by: generatedBy,
      mode: 'dry-run',
      results,
    });
  } catch (error) {
    console.error('POST /admin/retention/preview failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

async function resolveInviteDraftRequest(body: InviteDraftRequestBody): Promise<{
  draft: Awaited<ReturnType<typeof generateInviteDraft>>;
  source: 'event' | 'ad_hoc';
  tone: InviteTone;
}> {
  const eventId = body?.event_id?.trim();
  const toneRaw = body?.tone?.toLowerCase();
  const tone: InviteTone = toneRaw === 'professional' ? 'professional' : 'friendly';

  let title = body?.title?.trim();
  let eventDate = body?.event_date?.trim();
  let location = typeof body?.location === 'string' ? body.location.trim() : body?.location ?? null;
  let description = typeof body?.description === 'string' ? body.description.trim() : body?.description ?? null;

  if (eventId) {
    const pool = await getPool();
    const eventResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, eventId)
      .query<{ title: string; event_date: Date | string; location: string | null; description: string | null }>(
        `SELECT title, event_date, location, description
         FROM event
         WHERE event_id = @event_id`
      );

    const event = eventResult.recordset[0];
    if (!event) {
      throw new Error('Event not found.');
    }

    title = event.title;
    eventDate = new Date(event.event_date).toISOString();
    location = event.location;
    description = event.description;
  }

  if (!title || !eventDate) {
    throw new Error('title and event_date are required (or provide event_id).');
  }

  const draft = await generateInviteDraft({
    eventTitle: title,
    eventDate,
    location,
    description,
    tone,
  });

  return {
    draft,
    source: eventId ? 'event' : 'ad_hoc',
    tone,
  };
}

async function upsertNotificationTemplate(
  pool: Awaited<ReturnType<typeof getPool>>,
  input: { templateName: string; channel: 'email' | 'sms'; subject: string | null; body: string }
): Promise<{ template_id: string; updated_at: Date }> {
  const existing = await pool
    .request()
    .input('template_name', sql.NVarChar(100), input.templateName)
    .input('channel', sql.NVarChar(10), input.channel)
    .query<{ template_id: string }>(
      `SELECT TOP 1 template_id
       FROM notification_template
       WHERE template_name = @template_name
         AND channel = @channel`
    );

  const existingId = existing.recordset[0]?.template_id;
  if (existingId) {
    const updated = await pool
      .request()
      .input('template_id', sql.UniqueIdentifier, existingId)
      .input('subject', sql.NVarChar(300), input.channel === 'email' ? input.subject : null)
      .input('body', sql.NVarChar(sql.MAX), input.body)
      .query<{ template_id: string; updated_at: Date }>(
        `UPDATE notification_template
         SET subject = @subject,
             body = @body,
             is_active = 1,
             updated_at = GETUTCDATE()
         OUTPUT INSERTED.template_id, INSERTED.updated_at
         WHERE template_id = @template_id`
      );
    return updated.recordset[0];
  }

  const inserted = await pool
    .request()
    .input('template_name', sql.NVarChar(100), input.templateName)
    .input('channel', sql.NVarChar(10), input.channel)
    .input('subject', sql.NVarChar(300), input.channel === 'email' ? input.subject : null)
    .input('body', sql.NVarChar(sql.MAX), input.body)
    .query<{ template_id: string; updated_at: Date }>(
      `INSERT INTO notification_template (template_id, template_name, channel, subject, body, is_active, created_at, updated_at)
       OUTPUT INSERTED.template_id, INSERTED.updated_at
       VALUES (NEWID(), @template_name, @channel, @subject, @body, 1, GETUTCDATE(), GETUTCDATE())`
    );
  return inserted.recordset[0];
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

export default router;