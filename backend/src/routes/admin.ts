import { Router } from 'express';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/rbac';
import { generateInviteDraft } from '../services/aiInviteService';

const router = Router();

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
    const eventId = (req.body?.event_id as string | undefined)?.trim();
    const toneRaw = (req.body?.tone as string | undefined)?.toLowerCase();
    const tone = toneRaw === 'professional' ? 'professional' : 'friendly';

    let title = (req.body?.title as string | undefined)?.trim();
    let eventDate = (req.body?.event_date as string | undefined)?.trim();
    let location = (req.body?.location as string | undefined)?.trim() ?? null;
    let description = (req.body?.description as string | undefined)?.trim() ?? null;

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
        res.status(404).json({ error: 'Event not found.' });
        return;
      }

      title = event.title;
      eventDate = new Date(event.event_date).toISOString();
      location = event.location;
      description = event.description;
    }

    if (!title || !eventDate) {
      res.status(400).json({ error: 'title and event_date are required (or provide event_id).' });
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
      source: eventId ? 'event' : 'ad_hoc',
      tone,
    });
  } catch (error) {
    console.error('POST /admin/ai/invite-draft failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

export default router;