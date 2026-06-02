import { Router } from 'express';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { DEFAULT_TENANT_ID } from '../middleware/resolveTenantContext';
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

interface TemplateVersionRow {
  version_id: string;
  template_id: string;
  template_name: string;
  channel: NotificationChannel;
  subject: string | null;
  body: string;
  is_active: boolean;
  action: 'update' | 'deactivate' | 'rollback_before' | 'rollback_applied';
  reason: string | null;
  changed_by: string | null;
  created_at: Date;
}

type TemplateTenantSupport = {
  hasTemplateTenantId: boolean;
  hasTemplateVersionTenantId: boolean;
};

interface TemplateVersionWriteOptions {
  tenantId?: string;
  hasTemplateVersionTenantId: boolean;
}

let cachedTemplateTenantSupport: TemplateTenantSupport | null = null;

function parseChannel(value: unknown): NotificationChannel | undefined {
  if (value === 'email' || value === 'sms') {
    return value;
  }
  return undefined;
}

function isMultiTenantEnabled(): boolean {
  const raw = process.env['MULTI_TENANT_ENABLED'];
  if (!raw) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function resolveTenantId(req: { tenantId?: string }): string {
  return (req.tenantId ?? DEFAULT_TENANT_ID).trim().toLowerCase();
}

async function getTemplateTenantSupport(pool: Awaited<ReturnType<typeof getPool>>): Promise<TemplateTenantSupport> {
  if (cachedTemplateTenantSupport) {
    return cachedTemplateTenantSupport;
  }

  const result = await pool
    .request()
    .query<{ has_template_tenant_id: number; has_template_version_tenant_id: number }>(
      `SELECT
          CASE WHEN COL_LENGTH('dbo.notification_template', 'tenant_id') IS NULL THEN 0 ELSE 1 END AS has_template_tenant_id,
          CASE WHEN COL_LENGTH('dbo.notification_template_version', 'tenant_id') IS NULL THEN 0 ELSE 1 END AS has_template_version_tenant_id`
    );

  cachedTemplateTenantSupport = {
    hasTemplateTenantId: result.recordset[0]?.has_template_tenant_id === 1,
    hasTemplateVersionTenantId: result.recordset[0]?.has_template_version_tenant_id === 1,
  };

  return cachedTemplateTenantSupport;
}

async function writeTemplateVersion(
  template: TemplateRow,
  action: TemplateVersionRow['action'],
  changedBy: string | null,
  reason?: string | null,
  options?: TemplateVersionWriteOptions,
): Promise<void> {
  try {
    const pool = await getPool();
    const request = pool
      .request()
      .input('template_id', sql.UniqueIdentifier, template.template_id)
      .input('template_name', sql.NVarChar(100), template.template_name)
      .input('channel', sql.NVarChar(10), template.channel)
      .input('subject', sql.NVarChar(300), template.subject)
      .input('body', sql.NVarChar(sql.MAX), template.body)
      .input('is_active', sql.Bit, template.is_active ? 1 : 0)
      .input('action', sql.NVarChar(30), action)
      .input('reason', sql.NVarChar(500), reason ?? null)
      .input('changed_by', sql.NVarChar(255), changedBy);

    const includeTenant = Boolean(options?.tenantId && options.hasTemplateVersionTenantId);
    if (includeTenant) {
      request.input('tenant_id', sql.UniqueIdentifier, options?.tenantId ?? null);
    }

    await request.query(
      includeTenant
        ? `INSERT INTO notification_template_version
           (version_id, tenant_id, template_id, template_name, channel, subject, body, is_active, action, reason, changed_by, created_at)
           VALUES (NEWID(), @tenant_id, @template_id, @template_name, @channel, @subject, @body, @is_active, @action, @reason, @changed_by, GETUTCDATE())`
        : `INSERT INTO notification_template_version
           (version_id, template_id, template_name, channel, subject, body, is_active, action, reason, changed_by, created_at)
           VALUES (NEWID(), @template_id, @template_name, @channel, @subject, @body, @is_active, @action, @reason, @changed_by, GETUTCDATE())`
    );
  } catch (error) {
    // Non-blocking so template management still works if history table is not yet provisioned.
    console.warn('[templates] failed to write template version snapshot', {
      templateId: template.template_id,
      action,
      error,
    });
  }
}

router.get('/', apiLimiter, authenticate, requireAdmin, async (req, res, next) => {
  try {
    const channel = parseChannel(req.query.channel);
    const isActiveRaw = typeof req.query.is_active === 'string' ? req.query.is_active : undefined;
    const isActive = isActiveRaw === undefined ? undefined : isActiveRaw !== 'false';

    const pool = await getPool();
    const request = pool.request();
    const conditions: string[] = [];
    const tenantId = resolveTenantId(req);
    const tenantSupport = await getTemplateTenantSupport(pool);
    const applyTenantScope = isMultiTenantEnabled() && tenantSupport.hasTemplateTenantId;

    if (applyTenantScope) {
      request.input('tenant_id', sql.UniqueIdentifier, tenantId);
      conditions.push('tenant_id = @tenant_id');
    }

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
    const tenantId = resolveTenantId(req);
    const tenantSupport = await getTemplateTenantSupport(pool);
    const applyTenantScope = isMultiTenantEnabled() && tenantSupport.hasTemplateTenantId;

    const createRequest = pool
      .request()
      .input('template_name', sql.NVarChar(100), templateName)
      .input('channel', sql.NVarChar(10), channel)
      .input('subject', sql.NVarChar(300), channel === 'email' ? subject : null)
      .input('body', sql.NVarChar(sql.MAX), body);

    if (applyTenantScope) {
      createRequest.input('tenant_id', sql.UniqueIdentifier, tenantId);
    }

    const result = await createRequest.query<TemplateRow>(
      applyTenantScope
        ? `INSERT INTO notification_template (template_id, tenant_id, template_name, channel, subject, body, is_active, created_at, updated_at)
           OUTPUT INSERTED.template_id, INSERTED.template_name, INSERTED.channel, INSERTED.subject, INSERTED.body, INSERTED.is_active, INSERTED.created_at, INSERTED.updated_at
           VALUES (NEWID(), @tenant_id, @template_name, @channel, @subject, @body, 1, GETUTCDATE(), GETUTCDATE())`
        : `INSERT INTO notification_template (template_id, template_name, channel, subject, body, is_active, created_at, updated_at)
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
    const tenantId = resolveTenantId(req);
    const tenantSupport = await getTemplateTenantSupport(pool);
    const applyTenantScope = isMultiTenantEnabled() && tenantSupport.hasTemplateTenantId;
    const existingResult = await pool
      .request()
      .input('template_id', sql.UniqueIdentifier, templateId)
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .query<TemplateRow>(
        `SELECT template_id, template_name, channel, subject, body, is_active, created_at, updated_at
         FROM notification_template
         WHERE template_id = @template_id
           ${applyTenantScope ? 'AND tenant_id = @tenant_id' : ''}`
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

    await writeTemplateVersion(
      existing,
      'update',
      req.user?.email ?? req.user?.sub ?? null,
      typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null,
      {
        tenantId: applyTenantScope ? tenantId : undefined,
        hasTemplateVersionTenantId: tenantSupport.hasTemplateVersionTenantId,
      },
    );

    const updateRequest = pool
      .request()
      .input('template_id', sql.UniqueIdentifier, templateId)
      .input('template_name', sql.NVarChar(100), nextTemplateName)
      .input('channel', sql.NVarChar(10), nextChannel)
      .input('subject', sql.NVarChar(300), nextSubject)
      .input('body', sql.NVarChar(sql.MAX), nextBody)
      .input('is_active', sql.Bit, (isActive ?? existing.is_active) ? 1 : 0);

    if (applyTenantScope) {
      updateRequest.input('tenant_id', sql.UniqueIdentifier, tenantId);
    }

    const updatedResult = await updateRequest.query<TemplateRow>(
      `UPDATE notification_template
       SET template_name = @template_name,
           channel = @channel,
           subject = @subject,
           body = @body,
           is_active = @is_active,
           updated_at = GETUTCDATE()
       OUTPUT INSERTED.template_id, INSERTED.template_name, INSERTED.channel, INSERTED.subject, INSERTED.body, INSERTED.is_active, INSERTED.created_at, INSERTED.updated_at
       WHERE template_id = @template_id
         ${applyTenantScope ? 'AND tenant_id = @tenant_id' : ''}`
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
    const tenantId = resolveTenantId(req);
    const tenantSupport = await getTemplateTenantSupport(pool);
    const applyTenantScope = isMultiTenantEnabled() && tenantSupport.hasTemplateTenantId;

    const existingResult = await pool
      .request()
      .input('template_id', sql.UniqueIdentifier, templateId)
      .input('tenant_id', sql.UniqueIdentifier, tenantId)
      .query<TemplateRow>(
        `SELECT template_id, template_name, channel, subject, body, is_active, created_at, updated_at
         FROM notification_template
         WHERE template_id = @template_id
           ${applyTenantScope ? 'AND tenant_id = @tenant_id' : ''}`
      );

    const existing = existingResult.recordset[0];
    if (!existing) {
      res.status(404).json({ error: 'Template not found.' });
      return;
    }

    const deleteRequest = pool
      .request()
      .input('template_id', sql.UniqueIdentifier, templateId);

    if (applyTenantScope) {
      deleteRequest.input('tenant_id', sql.UniqueIdentifier, tenantId);
    }

    const result = await deleteRequest.query<TemplateRow>(
      `UPDATE notification_template
       SET is_active = 0,
           updated_at = GETUTCDATE()
       OUTPUT INSERTED.template_id, INSERTED.template_name, INSERTED.channel, INSERTED.subject, INSERTED.body, INSERTED.is_active, INSERTED.created_at, INSERTED.updated_at
       WHERE template_id = @template_id
         ${applyTenantScope ? 'AND tenant_id = @tenant_id' : ''}`
    );

    const row = result.recordset[0];

    await writeTemplateVersion(
      existing,
      'deactivate',
      req.user?.email ?? req.user?.sub ?? null,
      'Template deactivated',
      {
        tenantId: applyTenantScope ? tenantId : undefined,
        hasTemplateVersionTenantId: tenantSupport.hasTemplateVersionTenantId,
      },
    );

    res.json({
      ...row,
      created_at: row.created_at.toISOString(),
      updated_at: row.updated_at.toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:id/history', apiLimiter, authenticate, requireAdmin, async (req, res, next) => {
  try {
    const templateId = req.params.id;
    const pool = await getPool();
    const tenantId = resolveTenantId(req);
    const tenantSupport = await getTemplateTenantSupport(pool);
    const applyTenantScope = isMultiTenantEnabled() && tenantSupport.hasTemplateTenantId;

    if (applyTenantScope) {
      const templateResult = await pool
        .request()
        .input('template_id', sql.UniqueIdentifier, templateId)
        .input('tenant_id', sql.UniqueIdentifier, tenantId)
        .query<{ template_id: string }>(
          `SELECT TOP 1 template_id
           FROM notification_template
           WHERE template_id = @template_id
             AND tenant_id = @tenant_id`
        );

      if (!templateResult.recordset[0]) {
        res.status(404).json({ error: 'Template not found.' });
        return;
      }
    }

    const historyRequest = pool
      .request()
      .input('template_id', sql.UniqueIdentifier, templateId);

    if (applyTenantScope && tenantSupport.hasTemplateVersionTenantId) {
      historyRequest.input('tenant_id', sql.UniqueIdentifier, tenantId);
    }

    const result = await historyRequest.query<TemplateVersionRow>(
      `SELECT version_id, template_id, template_name, channel, subject, body, is_active, action, reason, changed_by, created_at
       FROM notification_template_version
       WHERE template_id = @template_id
         ${applyTenantScope && tenantSupport.hasTemplateVersionTenantId ? 'AND tenant_id = @tenant_id' : ''}
       ORDER BY created_at DESC`
    );

    res.json(result.recordset.map((row) => ({
      ...row,
      created_at: row.created_at.toISOString(),
    })));
  } catch (error) {
    next(error);
  }
});

router.post('/:id/rollback', writeLimiter, authenticate, requireAdmin, async (req, res, next) => {
  try {
    const templateId = req.params.id;
    const versionId = typeof req.body?.version_id === 'string' ? req.body.version_id.trim() : '';
    const approved = req.body?.approved === true;
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : null;

    if (!versionId) {
      res.status(400).json({ error: 'version_id is required.' });
      return;
    }
    if (!approved) {
      res.status(400).json({ error: 'approved must be true to perform rollback.' });
      return;
    }

    const pool = await getPool();
    const tenantId = resolveTenantId(req);
    const tenantSupport = await getTemplateTenantSupport(pool);
    const applyTenantScope = isMultiTenantEnabled() && tenantSupport.hasTemplateTenantId;

    const [templateResult, versionResult] = await Promise.all([
      pool
        .request()
        .input('template_id', sql.UniqueIdentifier, templateId)
        .input('tenant_id', sql.UniqueIdentifier, tenantId)
        .query<TemplateRow>(
          `SELECT template_id, template_name, channel, subject, body, is_active, created_at, updated_at
           FROM notification_template
           WHERE template_id = @template_id
             ${applyTenantScope ? 'AND tenant_id = @tenant_id' : ''}`
        ),
      pool
        .request()
        .input('template_id', sql.UniqueIdentifier, templateId)
        .input('version_id', sql.UniqueIdentifier, versionId)
        .input('tenant_id', sql.UniqueIdentifier, tenantId)
        .query<TemplateVersionRow>(
          `SELECT TOP 1 version_id, template_id, template_name, channel, subject, body, is_active, action, reason, changed_by, created_at
           FROM notification_template_version
           WHERE template_id = @template_id
             AND version_id = @version_id
             ${applyTenantScope && tenantSupport.hasTemplateVersionTenantId ? 'AND tenant_id = @tenant_id' : ''}`
        ),
    ]);

    const existing = templateResult.recordset[0];
    if (!existing) {
      res.status(404).json({ error: 'Template not found.' });
      return;
    }

    const targetVersion = versionResult.recordset[0];
    if (!targetVersion) {
      res.status(404).json({ error: 'Template version not found.' });
      return;
    }

    const changedBy = req.user?.email ?? req.user?.sub ?? null;
    await writeTemplateVersion(existing, 'rollback_before', changedBy, reason ?? `Rollback to version ${versionId}`, {
      tenantId: applyTenantScope ? tenantId : undefined,
      hasTemplateVersionTenantId: tenantSupport.hasTemplateVersionTenantId,
    });

    const updateRequest = pool
      .request()
      .input('template_id', sql.UniqueIdentifier, templateId)
      .input('template_name', sql.NVarChar(100), targetVersion.template_name)
      .input('channel', sql.NVarChar(10), targetVersion.channel)
      .input('subject', sql.NVarChar(300), targetVersion.subject)
      .input('body', sql.NVarChar(sql.MAX), targetVersion.body)
      .input('is_active', sql.Bit, targetVersion.is_active ? 1 : 0);

    if (applyTenantScope) {
      updateRequest.input('tenant_id', sql.UniqueIdentifier, tenantId);
    }

    const updateResult = await updateRequest.query<TemplateRow>(
      `UPDATE notification_template
       SET template_name = @template_name,
           channel = @channel,
           subject = @subject,
           body = @body,
           is_active = @is_active,
           updated_at = GETUTCDATE()
       OUTPUT INSERTED.template_id, INSERTED.template_name, INSERTED.channel, INSERTED.subject, INSERTED.body, INSERTED.is_active, INSERTED.created_at, INSERTED.updated_at
       WHERE template_id = @template_id
         ${applyTenantScope ? 'AND tenant_id = @tenant_id' : ''}`
    );

    const rolledBack = updateResult.recordset[0];
    if (!rolledBack) {
      res.status(404).json({ error: 'Template not found.' });
      return;
    }

    await writeTemplateVersion(rolledBack, 'rollback_applied', changedBy, reason ?? `Rollback to version ${versionId}`, {
      tenantId: applyTenantScope ? tenantId : undefined,
      hasTemplateVersionTenantId: tenantSupport.hasTemplateVersionTenantId,
    });

    res.json({
      ...rolledBack,
      created_at: rolledBack.created_at.toISOString(),
      updated_at: rolledBack.updated_at.toISOString(),
      rolled_back_to_version_id: versionId,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
