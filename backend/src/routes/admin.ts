import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/rbac';
import { generateInviteDraft } from '../services/aiInviteService';
import { isProvisioningEnabled, sendEntraInvitation } from '../services/identityProvisioningService';
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

interface IdentityStatusRow {
  member_id: string;
  status: 'pending' | 'invited' | 'linked' | 'disabled';
  identity_provider: string | null;
  entra_object_id: string | null;
  issuer: string | null;
  issuer_assigned_id: string | null;
  invited_at: Date | null;
  invite_email_sent_at: Date | null;
  linked_at: Date | null;
  last_sign_in_at: Date | null;
  updated_at: Date;
}

interface IdentityInviteTraceRow {
  trace_id: string;
  occurred_at: Date;
  mode: 'single' | 'bulk';
  member_id: string;
  email: string;
  invited_by: string;
  graph_invitation_id: string | null;
  invited_user_id: string | null;
  has_redeem_url: boolean;
  redirect_url_override: string | null;
  status: 'invited' | 'failed';
  error: string | null;
}

const MAX_INVITE_TITLE_LENGTH = 160;
const MAX_INVITE_LOCATION_LENGTH = 200;
const MAX_INVITE_DESCRIPTION_LENGTH = 2000;

function logIdentityInviteTrace(payload: {
  mode: 'single' | 'bulk';
  memberId: string;
  email: string;
  invitedBy: string;
  graphInvitationId: string | null;
  invitedUserId: string | null;
  hasRedeemUrl: boolean;
  redirectUrlOverride: string | null;
  status: 'invited' | 'failed';
  error?: string;
}): void {
  console.info('identity_invite_trace', {
    event: 'identity_invite_trace',
    timestamp: new Date().toISOString(),
    ...payload,
  });

  // Non-blocking persistence keeps invite delivery resilient if DB write fails.
  void persistIdentityInviteTrace(payload).catch((error) => {
    console.warn('identity_invite_trace_persist_failed', {
      event: 'identity_invite_trace_persist_failed',
      timestamp: new Date().toISOString(),
      memberId: payload.memberId,
      mode: payload.mode,
      status: payload.status,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  });
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
      if (
        error.message.includes('title and event_date are required')
        || error.message.includes('title must be <=')
        || error.message.includes('location must be <=')
        || error.message.includes('description must be <=')
        || error.message.includes('event_date must be a valid ISO date string')
      ) {
        res.status(400).json({ error: error.message });
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
      if (
        error.message.includes('title and event_date are required')
        || error.message.includes('title must be <=')
        || error.message.includes('location must be <=')
        || error.message.includes('description must be <=')
        || error.message.includes('event_date must be a valid ISO date string')
      ) {
        res.status(400).json({ error: error.message });
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

router.get('/identity/status/:memberId', async (req, res) => {
  try {
    const memberId = req.params.memberId;
    const status = await getIdentityStatusByMemberId(memberId);

    if (!status) {
      res.status(200).json({
        member_id: memberId,
        status: 'pending',
        identity_provider: null,
        invited_at: null,
        linked_at: null,
        last_sign_in_at: null,
      });
      return;
    }

    res.status(200).json(status);
  } catch (error) {
    console.error('GET /admin/identity/status/:memberId failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/identity/status/bulk', apiLimiter, async (req, res) => {
  try {
    const memberIdsRaw = req.body?.member_ids;
    if (!Array.isArray(memberIdsRaw)) {
      res.status(400).json({ error: 'member_ids array is required.' });
      return;
    }

    const memberIds = memberIdsRaw
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim());

    if (memberIds.length === 0) {
      res.status(200).json({ data: [] });
      return;
    }

    if (memberIds.length > 500) {
      res.status(400).json({ error: 'member_ids may not contain more than 500 records per request.' });
      return;
    }

    const pool = await getPool();
    const query = memberIds.map((_, index) => `@member_id_${index}`).join(', ');
    const request = pool.request();
    memberIds.forEach((memberId, index) => {
      request.input(`member_id_${index}`, sql.UniqueIdentifier, memberId);
    });

    const result = await request.query<IdentityStatusRow>(
      `SELECT member_id, status, identity_provider, entra_object_id, issuer, issuer_assigned_id,
              invited_at, invite_email_sent_at, linked_at, last_sign_in_at, updated_at
       FROM member_identity_link
       WHERE member_id IN (${query})`
    );

    const found = new Map(result.recordset.map((row) => [row.member_id.toLowerCase(), row]));
    const data = memberIds.map((memberId) => {
      const row = found.get(memberId.toLowerCase());
      if (row) {
        return row;
      }
      return {
        member_id: memberId,
        status: 'pending',
        identity_provider: null,
        entra_object_id: null,
        issuer: null,
        issuer_assigned_id: null,
        invited_at: null,
        invite_email_sent_at: null,
        linked_at: null,
        last_sign_in_at: null,
        updated_at: null,
      };
    });

    res.status(200).json({ data });
  } catch (error) {
    console.error('POST /admin/identity/status/bulk failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/identity/invite-trace/:memberId', async (req, res) => {
  try {
    const memberId = (req.params.memberId as string | undefined)?.trim();
    if (!memberId) {
      res.status(400).json({ error: 'memberId is required.' });
      return;
    }

    const limitRaw = parsePositiveInt(req.query.limit as string | undefined, 20);
    const limit = Math.min(limitRaw, 100);
    const traces = await getInviteTraceByMemberId(memberId, limit);
    res.status(200).json({ data: traces });
  } catch (error) {
    console.error('GET /admin/identity/invite-trace/:memberId failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/identity/invite', writeLimiter, async (req, res) => {
  try {
    if (!isProvisioningEnabled()) {
      res.status(503).json({ error: 'Entra provisioning is not configured for this environment.' });
      return;
    }

    const memberId = (req.body?.member_id as string | undefined)?.trim();
    const redirectUrl = (req.body?.redirect_url as string | undefined)?.trim();
    if (!memberId) {
      res.status(400).json({ error: 'member_id is required.' });
      return;
    }

    const member = await getMemberIdentityTarget(memberId);
    if (!member) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }
    if (!member.is_active) {
      res.status(400).json({ error: 'Cannot invite an inactive member.' });
      return;
    }
    if (!member.email) {
      res.status(400).json({ error: 'Member email is required before provisioning identity.' });
      return;
    }

    const invitation = await sendEntraInvitation({
      email: member.email,
      displayName: `${member.first_name} ${member.last_name}`.trim() || member.email,
      redirectUrl,
    });

    const currentUser = req.user?.email ?? req.user?.sub ?? 'unknown';
    await upsertMemberIdentityInvite(member.member_id, member.email, currentUser);
    logIdentityInviteTrace({
      mode: 'single',
      memberId: member.member_id,
      email: member.email,
      invitedBy: currentUser,
      graphInvitationId: invitation.id ?? null,
      invitedUserId: invitation.invitedUser?.id ?? null,
      hasRedeemUrl: Boolean(invitation.inviteRedeemUrl),
      redirectUrlOverride: redirectUrl ?? null,
      status: 'invited',
    });

    res.status(200).json({
      member_id: member.member_id,
      email: member.email,
      status: 'invited',
      invitation_id: invitation.id ?? null,
      invited_user_id: invitation.invitedUser?.id ?? null,
      invite_redeem_url: invitation.inviteRedeemUrl ?? null,
    });
  } catch (error) {
    console.error('POST /admin/identity/invite failed', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
});

router.post('/identity/invite/bulk', writeLimiter, async (req, res) => {
  try {
    if (!isProvisioningEnabled()) {
      res.status(503).json({ error: 'Entra provisioning is not configured for this environment.' });
      return;
    }

    const memberIdsRaw = req.body?.member_ids;
    const redirectUrl = (req.body?.redirect_url as string | undefined)?.trim();
    if (!Array.isArray(memberIdsRaw)) {
      res.status(400).json({ error: 'member_ids array is required.' });
      return;
    }

    const memberIds = memberIdsRaw
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim());

    if (memberIds.length === 0) {
      res.status(200).json({ results: [] });
      return;
    }
    if (memberIds.length > 100) {
      res.status(400).json({ error: 'member_ids may not contain more than 100 records per request.' });
      return;
    }

    const currentUser = req.user?.email ?? req.user?.sub ?? 'unknown';
    const results: Array<{ member_id: string; status: 'invited' | 'skipped' | 'failed'; reason?: string }> = [];

    for (const memberId of memberIds) {
      try {
        const member = await getMemberIdentityTarget(memberId);
        if (!member) {
          results.push({ member_id: memberId, status: 'skipped', reason: 'member_not_found' });
          continue;
        }
        if (!member.is_active) {
          results.push({ member_id: memberId, status: 'skipped', reason: 'member_inactive' });
          continue;
        }
        if (!member.email) {
          results.push({ member_id: memberId, status: 'skipped', reason: 'missing_email' });
          continue;
        }

        const invitation = await sendEntraInvitation({
          email: member.email,
          displayName: `${member.first_name} ${member.last_name}`.trim() || member.email,
          redirectUrl,
        });
        await upsertMemberIdentityInvite(member.member_id, member.email, currentUser);
        logIdentityInviteTrace({
          mode: 'bulk',
          memberId: member.member_id,
          email: member.email,
          invitedBy: currentUser,
          graphInvitationId: invitation.id ?? null,
          invitedUserId: invitation.invitedUser?.id ?? null,
          hasRedeemUrl: Boolean(invitation.inviteRedeemUrl),
          redirectUrlOverride: redirectUrl ?? null,
          status: 'invited',
        });
        results.push({ member_id: member.member_id, status: 'invited' });
      } catch (memberError) {
        logIdentityInviteTrace({
          mode: 'bulk',
          memberId,
          email: '',
          invitedBy: currentUser,
          graphInvitationId: null,
          invitedUserId: null,
          hasRedeemUrl: false,
          redirectUrlOverride: redirectUrl ?? null,
          status: 'failed',
          error: memberError instanceof Error ? memberError.message : 'invite_failed',
        });
        results.push({
          member_id: memberId,
          status: 'failed',
          reason: memberError instanceof Error ? memberError.message : 'invite_failed',
        });
      }
    }

    res.status(200).json({ results });
  } catch (error) {
    console.error('POST /admin/identity/invite/bulk failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/identity/relink', writeLimiter, async (req, res) => {
  try {
    const memberId = (req.body?.member_id as string | undefined)?.trim();
    const email = (req.body?.email as string | undefined)?.trim().toLowerCase();
    const entraObjectId = (req.body?.entra_object_id as string | undefined)?.trim();
    const issuer = (req.body?.issuer as string | undefined)?.trim();
    const issuerAssignedId = (req.body?.issuer_assigned_id as string | undefined)?.trim();
    const provider = (req.body?.identity_provider as string | undefined)?.trim();

    if (!memberId) {
      res.status(400).json({ error: 'member_id is required.' });
      return;
    }

    const normalizedEmail = email || null;
    const currentUser = req.user?.email ?? req.user?.sub ?? 'unknown';

    const pool = await getPool();
    await pool
      .request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .input('entra_object_id', sql.NVarChar(255), entraObjectId ?? null)
      .input('issuer', sql.NVarChar(255), issuer ?? null)
      .input('issuer_assigned_id', sql.NVarChar(255), issuerAssignedId ?? null)
      .input('identity_provider', sql.NVarChar(100), provider ?? null)
      .input('email', sql.NVarChar(255), normalizedEmail)
      .input('invited_by', sql.NVarChar(255), currentUser)
      .query(
        `MERGE member_identity_link AS target
         USING (SELECT @member_id AS member_id) AS source
         ON target.member_id = source.member_id
         WHEN MATCHED THEN
           UPDATE SET
             entra_object_id = COALESCE(@entra_object_id, target.entra_object_id),
             issuer = COALESCE(@issuer, target.issuer),
             issuer_assigned_id = COALESCE(@issuer_assigned_id, target.issuer_assigned_id),
             identity_provider = COALESCE(@identity_provider, target.identity_provider),
             last_seen_email = COALESCE(@email, target.last_seen_email),
             status = 'linked',
             linked_at = COALESCE(target.linked_at, GETUTCDATE()),
             last_sign_in_at = GETUTCDATE(),
             updated_at = GETUTCDATE(),
             invited_by = @invited_by
         WHEN NOT MATCHED THEN
           INSERT (
             link_id, member_id, entra_object_id, issuer, issuer_assigned_id, identity_provider,
             status, invited_at, invite_email_sent_at, linked_at, last_sign_in_at, last_seen_email,
             invited_by, created_at, updated_at
           )
           VALUES (
             NEWID(), @member_id, @entra_object_id, @issuer, @issuer_assigned_id, @identity_provider,
             'linked', NULL, NULL, GETUTCDATE(), GETUTCDATE(), @email,
             @invited_by, GETUTCDATE(), GETUTCDATE()
           );`
      );

    const updated = await getIdentityStatusByMemberId(memberId);
    res.status(200).json(updated);
  } catch (error) {
    console.error('POST /admin/identity/relink failed', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
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

  if (title.length > MAX_INVITE_TITLE_LENGTH) {
    throw new Error(`title must be <= ${MAX_INVITE_TITLE_LENGTH} characters.`);
  }

  if (location && location.length > MAX_INVITE_LOCATION_LENGTH) {
    throw new Error(`location must be <= ${MAX_INVITE_LOCATION_LENGTH} characters.`);
  }

  if (description && description.length > MAX_INVITE_DESCRIPTION_LENGTH) {
    throw new Error(`description must be <= ${MAX_INVITE_DESCRIPTION_LENGTH} characters.`);
  }

  if (Number.isNaN(new Date(eventDate).getTime())) {
    throw new Error('event_date must be a valid ISO date string.');
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

async function getIdentityStatusByMemberId(memberId: string): Promise<IdentityStatusRow | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query<IdentityStatusRow>(
      `SELECT TOP 1 member_id, status, identity_provider, entra_object_id, issuer, issuer_assigned_id,
              invited_at, invite_email_sent_at, linked_at, last_sign_in_at, updated_at
       FROM member_identity_link
       WHERE member_id = @member_id`
    );

  return result.recordset[0] ?? null;
}

async function getMemberIdentityTarget(memberId: string): Promise<{
  member_id: string;
  first_name: string;
  last_name: string;
  email: string;
  is_active: boolean;
} | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query<{
      member_id: string;
      first_name: string;
      last_name: string;
      email: string;
      is_active: boolean;
    }>(
      `SELECT member_id, first_name, last_name, email, is_active
       FROM member
       WHERE member_id = @member_id`
    );
  return result.recordset[0] ?? null;
}

async function upsertMemberIdentityInvite(memberId: string, email: string, invitedBy: string): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('email', sql.NVarChar(255), email)
    .input('invited_by', sql.NVarChar(255), invitedBy)
    .query(
      `MERGE member_identity_link AS target
       USING (SELECT @member_id AS member_id) AS source
       ON target.member_id = source.member_id
       WHEN MATCHED THEN
         UPDATE SET
           status = CASE WHEN target.status = 'linked' THEN target.status ELSE 'invited' END,
           invited_at = COALESCE(target.invited_at, GETUTCDATE()),
           invite_email_sent_at = GETUTCDATE(),
           last_seen_email = COALESCE(target.last_seen_email, @email),
           invited_by = @invited_by,
           updated_at = GETUTCDATE()
       WHEN NOT MATCHED THEN
         INSERT (
           link_id, member_id, status, invited_at, invite_email_sent_at, last_seen_email,
           invited_by, created_at, updated_at
         )
         VALUES (
           NEWID(), @member_id, 'invited', GETUTCDATE(), GETUTCDATE(), @email,
           @invited_by, GETUTCDATE(), GETUTCDATE()
         );`
    );
}

async function persistIdentityInviteTrace(payload: {
  mode: 'single' | 'bulk';
  memberId: string;
  email: string;
  invitedBy: string;
  graphInvitationId: string | null;
  invitedUserId: string | null;
  hasRedeemUrl: boolean;
  redirectUrlOverride: string | null;
  status: 'invited' | 'failed';
  error?: string;
}): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .query(
      `IF OBJECT_ID('identity_invite_trace', 'U') IS NULL
       BEGIN
         CREATE TABLE identity_invite_trace (
           trace_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
           occurred_at DATETIME2(3) NOT NULL DEFAULT SYSUTCDATETIME(),
           mode NVARCHAR(10) NOT NULL,
           member_id NVARCHAR(64) NOT NULL,
           email NVARCHAR(255) NOT NULL,
           invited_by NVARCHAR(255) NOT NULL,
           graph_invitation_id NVARCHAR(128) NULL,
           invited_user_id NVARCHAR(128) NULL,
           has_redeem_url BIT NOT NULL,
           redirect_url_override NVARCHAR(500) NULL,
           status NVARCHAR(20) NOT NULL,
           error NVARCHAR(MAX) NULL
         );

         CREATE INDEX IX_identity_invite_trace_member_occurred_at
           ON identity_invite_trace(member_id, occurred_at DESC);
       END`
    );

  await pool
    .request()
    .input('trace_id', sql.UniqueIdentifier, randomUUID())
    .input('mode', sql.NVarChar(10), payload.mode)
    .input('member_id', sql.NVarChar(64), payload.memberId)
    .input('email', sql.NVarChar(255), payload.email)
    .input('invited_by', sql.NVarChar(255), payload.invitedBy)
    .input('graph_invitation_id', sql.NVarChar(128), payload.graphInvitationId)
    .input('invited_user_id', sql.NVarChar(128), payload.invitedUserId)
    .input('has_redeem_url', sql.Bit, payload.hasRedeemUrl ? 1 : 0)
    .input('redirect_url_override', sql.NVarChar(500), payload.redirectUrlOverride)
    .input('status', sql.NVarChar(20), payload.status)
    .input('error', sql.NVarChar(sql.MAX), payload.error ?? null)
    .query(
      `INSERT INTO identity_invite_trace (
         trace_id, mode, member_id, email, invited_by, graph_invitation_id,
         invited_user_id, has_redeem_url, redirect_url_override, status, error
       )
       VALUES (
         @trace_id, @mode, @member_id, @email, @invited_by, @graph_invitation_id,
         @invited_user_id, @has_redeem_url, @redirect_url_override, @status, @error
       )`
    );
}

async function getInviteTraceByMemberId(memberId: string, limit: number): Promise<IdentityInviteTraceRow[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.NVarChar(64), memberId)
    .input('limit', sql.Int, limit)
    .query<IdentityInviteTraceRow>(
      `IF OBJECT_ID('identity_invite_trace', 'U') IS NULL
       BEGIN
         SELECT TOP 0
           CAST(NULL AS UNIQUEIDENTIFIER) AS trace_id,
           CAST(NULL AS DATETIME2(3)) AS occurred_at,
           CAST(NULL AS NVARCHAR(10)) AS mode,
           CAST(NULL AS NVARCHAR(64)) AS member_id,
           CAST(NULL AS NVARCHAR(255)) AS email,
           CAST(NULL AS NVARCHAR(255)) AS invited_by,
           CAST(NULL AS NVARCHAR(128)) AS graph_invitation_id,
           CAST(NULL AS NVARCHAR(128)) AS invited_user_id,
           CAST(NULL AS BIT) AS has_redeem_url,
           CAST(NULL AS NVARCHAR(500)) AS redirect_url_override,
           CAST(NULL AS NVARCHAR(20)) AS status,
           CAST(NULL AS NVARCHAR(MAX)) AS error;
       END
       ELSE
       BEGIN
         SELECT TOP (@limit)
           trace_id,
           occurred_at,
           mode,
           member_id,
           email,
           invited_by,
           graph_invitation_id,
           invited_user_id,
           has_redeem_url,
           redirect_url_override,
           status,
           error
         FROM identity_invite_trace
         WHERE member_id = @member_id
         ORDER BY occurred_at DESC;
       END`
    );

  return result.recordset;
}

export default router;