import { Router } from 'express';
import { randomUUID } from 'crypto';
import { getPool, sql } from '../db';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/rbac';
import { loadEntraProvisioningConfig } from '../config';
import { generateInviteDraft } from '../services/aiInviteService';
import { isProvisioningEnabled, sendEntraInvitation } from '../services/identityProvisioningService';
import { appendMemberInviteTokenToLoginUrl, issueIdentityInviteClaim } from '../services/identityInviteClaimService';
import {
  assignAppRole,
  getUserRoleAssignments,
  isGraphRoleManagementConfigured,
  listAvailableAppRoles,
  lookupEntraUserByEmail,
  removeAppRole,
} from '../services/graphRoleService';
import { notificationService } from '../services/notifications';
import { runRetentionJob } from '../jobs/retentionJob';

const router = Router();
const APP_DB_ROLES = ['admin', 'superadmin', 'event_creator', 'tavf_creator', 'user'] as const;

type InviteTone = 'friendly' | 'professional';

interface InviteDraftRequestBody {
  event_id?: string;
  title?: string;
  event_date?: string;
  location?: string | null;
  description?: string | null;
  subject?: string;
  emailBody?: string;
  smsBody?: string;
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
  updated_at: Date | null;
}

interface IdentityStatusJoinedRow {
  member_id: string;
  member_email: string;
  link_status: 'pending' | 'invited' | 'linked' | 'disabled' | null;
  identity_provider: string | null;
  entra_object_id: string | null;
  issuer: string | null;
  issuer_assigned_id: string | null;
  invited_at: Date | null;
  invite_email_sent_at: Date | null;
  linked_at: Date | null;
  last_sign_in_at: Date | null;
  link_updated_at: Date | null;
  app_user_email: string | null;
  app_user_azure_oid: string | null;
  app_user_last_login: Date | null;
  app_user_created_at: Date | null;
  app_user_updated_at: Date | null;
}

interface AppUserLookupRow {
  email: string | null;
  azure_oid: string | null;
  last_login: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
}

interface IdentityStatusSummary {
  total_members: number;
  pending: number;
  invited: number;
  access: number;
  signed_in: number;
  disabled: number;
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

interface IdentityReconcileResponse {
  scanned: number;
  reconciled: number;
  data: IdentityStatusRow[];
}

const MAX_INVITE_TITLE_LENGTH = 160;
const MAX_INVITE_LOCATION_LENGTH = 200;
const MAX_INVITE_DESCRIPTION_LENGTH = 2000;
const IDENTITY_GRAPH_LOOKUP_BATCH_SIZE = 10;

const DEFAULT_PORTAL_LOGIN_URL = 'https://app.phwcoloradoalpine.org/login';

function normalizePortalLoginUrl(candidate?: string | null): string {
  let configuredDefault = DEFAULT_PORTAL_LOGIN_URL;
  const configuredRedirect = loadEntraProvisioningConfig().redirectUrl?.trim();
  if (configuredRedirect) {
    try {
      const parsedConfigured = new URL(configuredRedirect);
      parsedConfigured.pathname = '/login';
      parsedConfigured.search = '';
      parsedConfigured.hash = '';
      configuredDefault = parsedConfigured.toString();
    } catch {
      configuredDefault = DEFAULT_PORTAL_LOGIN_URL;
    }
  }

  if (!candidate?.trim()) {
    return configuredDefault;
  }

  try {
    const expected = new URL(configuredDefault);
    const parsedCandidate = new URL(candidate.trim());
    if (parsedCandidate.origin !== expected.origin) {
      return configuredDefault;
    }

    const inviteToken = parsedCandidate.searchParams.get('invite');

    parsedCandidate.pathname = '/login';
    parsedCandidate.search = '';
    if (inviteToken) {
      parsedCandidate.searchParams.set('invite', inviteToken);
    }
    parsedCandidate.hash = '';
    return parsedCandidate.toString();
  } catch {
    return configuredDefault;
  }
}

async function sendIdentityAccessEmail(input: {
  to: string;
  firstName: string;
  signInUrl: string;
}): Promise<void> {
  const safeName = input.firstName?.trim() || 'there';
  const safeUrl = normalizePortalLoginUrl(input.signInUrl);
  let signInGuideUrl = 'https://app.phwcoloradoalpine.org/onboarding/sign-in-options.png';
  let smsConsentGuideUrl = 'https://app.phwcoloradoalpine.org/images/sms-consent.png';
  let appOrigin = 'https://app.phwcoloradoalpine.org';
  try {
    appOrigin = new URL(safeUrl).origin;
    signInGuideUrl = `${appOrigin}/onboarding/sign-in-options.png`;
    smsConsentGuideUrl = `${appOrigin}/images/sms-consent.png`;
  } catch {
    // Keep defaults when safeUrl is not a valid absolute URL.
  }
  const notifPrefsUrl = `${appOrigin}/notification-preferences`;

  await notificationService.sendEmail({
    to: input.to,
    subject: 'Welcome to PHW Alpine Events - Sign-in Instructions',
    htmlBody: `<p>Hi ${safeName},</p>
<p>Welcome to PHW Alpine Events. We are very glad you are here.</p>
<p><strong>Sign in here:</strong><br/>
<a href="${safeUrl}">${safeUrl}</a></p>
<p><strong>Where to click:</strong><br/>
Use this quick screenshot guide on the sign-in page.</p>
<p><a href="${signInGuideUrl}"><img src="${signInGuideUrl}" alt="PHW Alpine sign-in page showing Google and email sign-in choices" style="max-width:100%;border:1px solid #d0d7de;border-radius:8px;" /></a></p>
<p><strong>Step-by-step:</strong></p>
<ol>
  <li>Open the sign-in link above.</li>
  <li>Choose one sign-in method:</li>
</ol>
<p><strong>Option A: Google sign-in</strong><br/>
Click <strong>Sign in with Google</strong>, then follow the Google prompts.</p>
<p><strong>Option B: Email one-time code (OTP)</strong></p>
<ol>
  <li>Choose the email sign-in option and enter your email address.</li>
  <li>On your first sign-in, choose <strong>Create one</strong> when prompted.</li>
  <li>Check your email for the code, enter it, and continue.</li>
  <li>After setup, use the same email sign-in option each time.</li>
</ol>
<hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0;"/>
<p><strong>Optional: Enable SMS text notifications</strong></p>
<p>Once you are signed in, you can opt in to receive event invitations, RSVP reminders, and schedule updates by text message.</p>
<p><strong>How to turn on SMS:</strong></p>
<ol>
  <li>Sign in at the link above.</li>
  <li>Go to <a href="${notifPrefsUrl}">Notification Preferences</a>.</li>
  <li>Enter your mobile number and check the box to enable SMS.</li>
  <li>Save your preferences.</li>
</ol>
<p><strong>What it looks like:</strong></p>
<p><a href="${smsConsentGuideUrl}"><img src="${smsConsentGuideUrl}" alt="Notification Preferences screen showing the SMS consent checkbox and Save preferences button" style="max-width:100%;border:1px solid #d0d7de;border-radius:8px;" /></a></p>
<p style="font-size:12px;color:#6b7280;">Message frequency varies. Message and data rates may apply. Reply STOP to opt out at any time. Reply HELP for help.</p>
<p>If anything looks confusing, simply reply to this email and we will help right away.</p>
<p>Thank you,<br/>Project Healing Waters Colorado Alpine</p>`,
    textBody: `Hi ${safeName},\n\nWelcome to PHW Alpine Events. We are very glad you are here.\n\nSign in here:\n${safeUrl}\n\nScreenshot guide (where to click):\n${signInGuideUrl}\n\nStep-by-step:\n1) Open the sign-in link above.\n2) Choose one sign-in method.\n\nOption A: Google sign-in\n- Select Sign in with Google and continue.\n\nOption B: Email one-time code (OTP)\n1) Choose the email sign-in option and enter your email.\n2) First time only: choose Create one when prompted.\n3) Check your email for the code and enter it.\n4) After setup, use the same email sign-in option each time.\n\n---\n\nOptional: Enable SMS text notifications\n\nOnce signed in, you can receive event invitations, RSVP reminders, and updates by text message.\n\nHow to turn on SMS:\n1) Sign in at the link above.\n2) Go to Notification Preferences: ${notifPrefsUrl}\n3) Enter your mobile number and check the box to enable SMS.\n4) Save your preferences.\n\nScreenshot guide (SMS section):\n${smsConsentGuideUrl}\n\nMessage frequency varies. Message and data rates may apply. Reply STOP to opt out. Reply HELP for help.\n\nIf anything is confusing, reply to this email and we will help right away.\n\nThank you,\nProject Healing Waters Colorado Alpine`,
    operationType: 'identity_access_invite',
  });
}

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

    if (role && !APP_DB_ROLES.includes(role as (typeof APP_DB_ROLES)[number])) {
      res.status(400).json({ error: `role must be one of: ${APP_DB_ROLES.join(', ')}` });
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
    if (!APP_DB_ROLES.includes(role as (typeof APP_DB_ROLES)[number])) {
      res.status(400).json({ error: `role must be one of: ${APP_DB_ROLES.join(', ')}` });
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
    if (role !== undefined && !APP_DB_ROLES.includes(role as (typeof APP_DB_ROLES)[number])) {
      res.status(400).json({ error: `role must be one of: ${APP_DB_ROLES.join(', ')}` });
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

router.delete('/users/:id', writeLimiter, async (req, res) => {
  try {
    const userId = (req.params.id ?? '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      res.status(400).json({ error: 'user_id must be a valid UUID.' });
      return;
    }

    const pool = await getPool();
    const lookup = await pool
      .request()
      .input('user_id', sql.UniqueIdentifier, userId)
      .query<{ user_id: string; role: string; email: string | null }>(
        `SELECT user_id, role, email
         FROM [user]
         WHERE user_id = @user_id`
      );

    const target = lookup.recordset[0];
    if (!target) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    const currentEmail = (req.user?.email ?? '').trim().toLowerCase();
    const targetEmail = (target.email ?? '').trim().toLowerCase();
    if (currentEmail && targetEmail && currentEmail === targetEmail) {
      res.status(400).json({ error: 'You cannot delete your own account.' });
      return;
    }

    if ((target.role ?? '').toLowerCase() === 'superadmin') {
      const superAdminCount = await pool
        .request()
        .query<{ total: number }>(
          `SELECT COUNT(1) AS total
           FROM [user]
           WHERE role = 'superadmin' AND is_active = 1`
        );

      if ((superAdminCount.recordset[0]?.total ?? 0) <= 1) {
        res.status(409).json({ error: 'Cannot delete the last active superadmin.' });
        return;
      }
    }

    await pool
      .request()
      .input('user_id', sql.UniqueIdentifier, userId)
      .query('DELETE FROM [user] WHERE user_id = @user_id');

    res.status(200).json({ message: 'User deleted.', user_id: userId });
  } catch (error) {
    console.error('DELETE /admin/users/:id failed', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── App-role management (Microsoft Graph) ────────────────────────────────────

router.get('/app-roles/available', apiLimiter, authenticate, requireAdmin, async (_req, res) => {
  try {
    if (!isGraphRoleManagementConfigured()) {
      res.status(503).json({ error: 'Graph role management is not configured. Set ENTRA_PROVISIONING_CLIENT_ID and ENTRA_PROVISIONING_CLIENT_SECRET.' });
      return;
    }
    const roles = await listAvailableAppRoles();
    res.json({ roles });
  } catch (error) {
    console.error('GET /admin/app-roles/available failed', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
});

router.get('/app-roles/users', apiLimiter, authenticate, requireAdmin, async (req, res) => {
  try {
    const email = (req.query.email as string | undefined)?.trim().toLowerCase();
    if (!email) {
      res.status(400).json({ error: 'email query parameter is required' });
      return;
    }
    if (!isGraphRoleManagementConfigured()) {
      res.status(503).json({ error: 'Graph role management is not configured.' });
      return;
    }
    const assignments = await getUserRoleAssignments(email);
    res.json({ email, assignments });
  } catch (error) {
    console.error('GET /admin/app-roles/users failed', error);
    res.status(error instanceof Error && error.message.includes('No Entra user') ? 404 : 500)
      .json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
});

router.post('/app-roles/assign', writeLimiter, authenticate, requireAdmin, async (req, res) => {
  try {
    const email = (req.body?.email as string | undefined)?.trim().toLowerCase();
    const role  = (req.body?.role as string | undefined)?.trim().toUpperCase();
    if (!email || !role) {
      res.status(400).json({ error: 'email and role are required' });
      return;
    }
    if (!isGraphRoleManagementConfigured()) {
      res.status(503).json({ error: 'Graph role management is not configured.' });
      return;
    }
    const assignment = await assignAppRole(email, role);
    res.status(201).json(assignment);
  } catch (error) {
    console.error('POST /admin/app-roles/assign failed', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  }
});

router.delete('/app-roles/assignments/:assignmentId', writeLimiter, authenticate, requireAdmin, async (req, res) => {
  try {
    const { assignmentId } = req.params;
    if (!assignmentId?.trim()) {
      res.status(400).json({ error: 'assignmentId is required' });
      return;
    }
    if (!isGraphRoleManagementConfigured()) {
      res.status(503).json({ error: 'Graph role management is not configured.' });
      return;
    }
    await removeAppRole(assignmentId);
    res.json({ message: 'Role assignment removed.' });
  } catch (error) {
    console.error('DELETE /admin/app-roles/assignments/:assignmentId failed', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
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
    const subjectOverride = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
    const emailBodyOverride = typeof req.body?.emailBody === 'string' ? req.body.emailBody.trim() : '';
    const smsBodyOverride = typeof req.body?.smsBody === 'string' ? req.body.smsBody.trim() : '';

    const finalSubject = subjectOverride || draft.subject;
    const finalEmailBody = emailBodyOverride || draft.emailBody;
    const finalSmsBody = smsBodyOverride || draft.smsBody;

    if (!finalSubject) {
      res.status(400).json({ error: 'subject is required.' });
      return;
    }
    if (finalSubject.length > 300) {
      res.status(400).json({ error: 'subject must be <= 300 characters.' });
      return;
    }
    if (!finalEmailBody) {
      res.status(400).json({ error: 'emailBody is required.' });
      return;
    }
    if (!finalSmsBody) {
      res.status(400).json({ error: 'smsBody is required.' });
      return;
    }

    const pool = await getPool();

    const [emailTemplate, smsTemplate] = await Promise.all([
      upsertNotificationTemplate(pool, {
        templateName,
        channel: 'email',
        subject: finalSubject,
        body: finalEmailBody,
      }),
      upsertNotificationTemplate(pool, {
        templateName,
        channel: 'sms',
        subject: null,
        body: finalSmsBody,
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

router.get('/identity/status/:memberId([0-9a-fA-F-]{36})', async (req, res) => {
  try {
    const memberId = req.params.memberId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(memberId)) {
      res.status(400).json({ error: 'memberId must be a valid UUID.' });
      return;
    }
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

    const result = await getIdentityStatusesByMemberIds(memberIds);

    const found = new Map(result.map((row) => [row.member_id.toLowerCase(), row]));
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

router.get('/identity/status/summary', apiLimiter, async (_req, res) => {
  try {
    const pool = await getPool();
    const memberResult = await pool
      .request()
      .query<{ member_id: string }>(
        `SELECT member_id
         FROM member
         WHERE is_active = 1`
      );

    const memberIds = memberResult.recordset.map((row) => row.member_id);
    if (memberIds.length === 0) {
      res.status(200).json({
        total_members: 0,
        pending: 0,
        invited: 0,
        access: 0,
        signed_in: 0,
        disabled: 0,
      } satisfies IdentityStatusSummary);
      return;
    }

    const statuses: IdentityStatusRow[] = [];
    const chunkSize = 400;
    for (let index = 0; index < memberIds.length; index += chunkSize) {
      const chunk = memberIds.slice(index, index + chunkSize);
      const chunkStatuses = await getIdentityStatusesByMemberIds(chunk);
      statuses.push(...chunkStatuses);
    }

    const summary: IdentityStatusSummary = {
      total_members: memberIds.length,
      pending: 0,
      invited: 0,
      access: 0,
      signed_in: 0,
      disabled: 0,
    };

    for (const status of statuses) {
      if (status.status === 'linked') {
        summary.access += 1;
      } else if (status.status === 'invited') {
        summary.invited += 1;
      } else if (status.status === 'disabled') {
        summary.disabled += 1;
      } else {
        summary.pending += 1;
      }

      if (status.last_sign_in_at) {
        summary.signed_in += 1;
      }
    }

    res.status(200).json(summary);
  } catch (error) {
    console.error('GET /admin/identity/status/summary failed', error);
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
    const redirectUrl = normalizePortalLoginUrl((req.body?.redirect_url as string | undefined)?.trim());
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

    const existingStatus = await getIdentityStatusByMemberId(member.member_id);
    if (existingStatus?.status === 'linked') {
      res.status(409).json({ error: 'Member already has access. No duplicate invite was sent.' });
      return;
    }
    if (existingStatus?.status === 'invited') {
      res.status(409).json({ error: 'Member already has a pending access invite. No duplicate invite was sent.' });
      return;
    }
    if (existingStatus?.status === 'disabled') {
      res.status(409).json({ error: 'Member access is disabled. Re-enable or relink instead of sending a new invite.' });
      return;
    }

    const invitation = await sendEntraInvitation({
      email: member.email,
      displayName: `${member.first_name} ${member.last_name}`.trim() || member.email,
      redirectUrl,
    });

    const currentUser = req.user?.email ?? req.user?.sub ?? 'unknown';
    const inviteClaim = await issueIdentityInviteClaim(member.member_id, member.email, currentUser);
    await upsertMemberIdentityInvite(member.member_id, member.email, currentUser, invitation.invitedUser?.id ?? null);
    const signInUrl = appendMemberInviteTokenToLoginUrl(
      normalizePortalLoginUrl(invitation.inviteRedeemUrl),
      inviteClaim.claimToken
    );
    try {
      await sendIdentityAccessEmail({
        to: member.email,
        firstName: member.first_name,
        signInUrl,
      });
    } catch (emailError) {
      console.warn('Identity invite email send failed', {
        memberId: member.member_id,
        email: member.email,
        error: emailError instanceof Error ? emailError.message : String(emailError),
      });
    }
    logIdentityInviteTrace({
      mode: 'single',
      memberId: member.member_id,
      email: member.email,
      invitedBy: currentUser,
      graphInvitationId: invitation.id ?? null,
      invitedUserId: invitation.invitedUser?.id ?? null,
      hasRedeemUrl: Boolean(invitation.inviteRedeemUrl),
      redirectUrlOverride: redirectUrl,
      status: 'invited',
    });

    res.status(200).json({
      member_id: member.member_id,
      email: member.email,
      status: 'invited',
      invitation_id: invitation.id ?? null,
      invited_user_id: invitation.invitedUser?.id ?? null,
      invite_redeem_url: signInUrl,
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
    const redirectUrl = normalizePortalLoginUrl((req.body?.redirect_url as string | undefined)?.trim());
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
    const existingStatuses = await getIdentityStatusesByMemberIds(memberIds);
    const existingStatusByMemberId = new Map(existingStatuses.map((status) => [status.member_id.toLowerCase(), status]));

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

        const existingStatus = existingStatusByMemberId.get(member.member_id.toLowerCase());
        if (existingStatus?.status === 'linked') {
          results.push({ member_id: member.member_id, status: 'skipped', reason: 'already_has_access' });
          continue;
        }
        if (existingStatus?.status === 'invited') {
          results.push({ member_id: member.member_id, status: 'skipped', reason: 'already_invited' });
          continue;
        }
        if (existingStatus?.status === 'disabled') {
          results.push({ member_id: member.member_id, status: 'skipped', reason: 'access_disabled' });
          continue;
        }

        const invitation = await sendEntraInvitation({
          email: member.email,
          displayName: `${member.first_name} ${member.last_name}`.trim() || member.email,
          redirectUrl,
        });
        const inviteClaim = await issueIdentityInviteClaim(member.member_id, member.email, currentUser);
        await upsertMemberIdentityInvite(member.member_id, member.email, currentUser, invitation.invitedUser?.id ?? null);
        const signInUrl = appendMemberInviteTokenToLoginUrl(
          normalizePortalLoginUrl(invitation.inviteRedeemUrl),
          inviteClaim.claimToken
        );
        try {
          await sendIdentityAccessEmail({
            to: member.email,
            firstName: member.first_name,
            signInUrl,
          });
        } catch (emailError) {
          console.warn('Identity invite email send failed', {
            memberId: member.member_id,
            email: member.email,
            error: emailError instanceof Error ? emailError.message : String(emailError),
          });
        }
        logIdentityInviteTrace({
          mode: 'bulk',
          memberId: member.member_id,
          email: member.email,
          invitedBy: currentUser,
          graphInvitationId: invitation.id ?? null,
          invitedUserId: invitation.invitedUser?.id ?? null,
          hasRedeemUrl: Boolean(invitation.inviteRedeemUrl),
          redirectUrlOverride: redirectUrl,
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

router.post('/identity/reconcile', writeLimiter, async (req, res) => {
  try {
    const memberIdsRaw = req.body?.member_ids;
    let memberIds: string[];

    if (memberIdsRaw === undefined) {
      memberIds = await getActiveMemberIds();
    } else {
      if (!Array.isArray(memberIdsRaw)) {
        res.status(400).json({ error: 'member_ids must be an array when provided.' });
        return;
      }

      memberIds = memberIdsRaw
        .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
        .map((value) => value.trim());
    }

    if (memberIds.length === 0) {
      res.status(200).json({ scanned: 0, reconciled: 0, data: [] } satisfies IdentityReconcileResponse);
      return;
    }

    if (memberIds.length > 500) {
      res.status(400).json({ error: 'member_ids may not contain more than 500 records per request.' });
      return;
    }

    const before = await getIdentityStatusesByMemberIds(memberIds, { reconcile: false });
    const after = await getIdentityStatusesByMemberIds(memberIds);
    const beforeByMemberId = new Map(before.map((status) => [status.member_id.toLowerCase(), status]));

    const reconciled = after.filter((status) => {
      if (status.status !== 'linked') {
        return false;
      }

      return beforeByMemberId.get(status.member_id.toLowerCase())?.status !== 'linked';
    }).length;

    res.status(200).json({
      scanned: memberIds.length,
      reconciled,
      data: after,
    } satisfies IdentityReconcileResponse);
  } catch (error) {
    console.error('POST /admin/identity/reconcile failed', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
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
  const statuses = await getIdentityStatusesByMemberIds([memberId]);
  return statuses[0] ?? null;
}

async function getIdentityStatusesByMemberIds(
  memberIds: string[],
  options: { reconcile?: boolean } = {}
): Promise<IdentityStatusRow[]> {
  if (memberIds.length === 0) {
    return [];
  }

  let rows = await loadIdentityStatusJoinedRows(memberIds);

  rows = await applyAppUserEmailNormalizationFallback(rows);

  if (options.reconcile !== false) {
    rows = await applyFederatedGraphAcceptanceFallback(rows);
  }

  return rows.map(toIdentityStatusRow);
}

async function loadIdentityStatusJoinedRows(memberIds: string[]): Promise<IdentityStatusJoinedRow[]> {
  const pool = await getPool();
  const query = memberIds.map((_, index) => `@member_id_${index}`).join(', ');
  const request = pool.request();
  memberIds.forEach((memberId, index) => {
    request.input(`member_id_${index}`, sql.UniqueIdentifier, memberId);
  });

  const result = await request.query<IdentityStatusJoinedRow>(
    `SELECT
       m.member_id,
       m.email AS member_email,
       mil.status AS link_status,
       mil.identity_provider,
       mil.entra_object_id,
       mil.issuer,
       mil.issuer_assigned_id,
       mil.invited_at,
       mil.invite_email_sent_at,
       mil.linked_at,
       mil.last_sign_in_at,
       mil.updated_at AS link_updated_at,
       u.email AS app_user_email,
       u.azure_oid AS app_user_azure_oid,
       u.last_login AS app_user_last_login,
       u.created_at AS app_user_created_at,
       u.updated_at AS app_user_updated_at
     FROM member m
     LEFT JOIN member_identity_link mil ON mil.member_id = m.member_id
     OUTER APPLY (
       SELECT TOP 1
         user_match.email,
         user_match.azure_oid,
         user_match.last_login,
         user_match.created_at,
         user_match.updated_at
       FROM dbo.[user] user_match
       WHERE user_match.is_active = 1
         AND (
           LOWER(user_match.email) = LOWER(m.email)
           OR (mil.last_seen_email IS NOT NULL AND LOWER(user_match.email) = LOWER(mil.last_seen_email))
           OR (mil.issuer_assigned_id IS NOT NULL AND LOWER(user_match.email) = LOWER(mil.issuer_assigned_id))
           OR (mil.entra_object_id IS NOT NULL AND user_match.azure_oid = mil.entra_object_id)
         )
       ORDER BY
         CASE
           WHEN LOWER(user_match.email) = LOWER(m.email) THEN 0
           WHEN mil.entra_object_id IS NOT NULL AND user_match.azure_oid = mil.entra_object_id THEN 1
           WHEN mil.last_seen_email IS NOT NULL AND LOWER(user_match.email) = LOWER(mil.last_seen_email) THEN 2
           WHEN mil.issuer_assigned_id IS NOT NULL AND LOWER(user_match.email) = LOWER(mil.issuer_assigned_id) THEN 3
           ELSE 4
         END,
         user_match.last_login DESC,
         user_match.updated_at DESC
     ) u
     WHERE m.member_id IN (${query})`
  );

  return Array.from(result.recordset);
}

async function getActiveMemberIds(): Promise<string[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .query<{ member_id: string }>(
      `SELECT member_id
       FROM member
       WHERE is_active = 1
       ORDER BY member_id`
    );

  return result.recordset
    .map((row) => row.member_id)
    .filter((memberId): memberId is string => typeof memberId === 'string' && memberId.length > 0);
}

function normalizeEmailForIdentityMatch(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const extIndex = normalized.indexOf('#ext#@');
  if (extIndex > 0) {
    const localAndDomain = normalized.slice(0, extIndex);
    const separatorIndex = localAndDomain.lastIndexOf('_');
    if (separatorIndex > 0 && separatorIndex < localAndDomain.length - 1) {
      const localPart = localAndDomain.slice(0, separatorIndex);
      const domainPart = localAndDomain.slice(separatorIndex + 1);
      if (localPart && domainPart) {
        return `${localPart}@${domainPart}`;
      }
    }
  }

  if (normalized.includes('@')) {
    return normalized;
  }

  return null;
}

function compareAppUserRows(a: AppUserLookupRow, b: AppUserLookupRow): number {
  const aLastLogin = a.last_login?.getTime() ?? 0;
  const bLastLogin = b.last_login?.getTime() ?? 0;
  if (aLastLogin !== bLastLogin) {
    return bLastLogin - aLastLogin;
  }

  const aUpdated = a.updated_at?.getTime() ?? a.created_at?.getTime() ?? 0;
  const bUpdated = b.updated_at?.getTime() ?? b.created_at?.getTime() ?? 0;
  return bUpdated - aUpdated;
}

async function applyAppUserEmailNormalizationFallback(rows: IdentityStatusJoinedRow[]): Promise<IdentityStatusJoinedRow[]> {
  const candidates = rows.filter((row) => {
    if (!row.member_email) {
      return false;
    }
    return !(row.app_user_email || row.app_user_azure_oid || row.app_user_last_login);
  });

  if (candidates.length === 0) {
    return rows;
  }

  const normalizedMemberEmails = Array.from(new Set(
    candidates
      .map((row) => normalizeEmailForIdentityMatch(row.member_email))
      .filter((value): value is string => Boolean(value))
  ));

  if (normalizedMemberEmails.length === 0) {
    return rows;
  }

  const pool = await getPool();
  const request = pool.request();
  const emailParams = normalizedMemberEmails.map((value, index) => {
    const key = `normalized_email_${index}`;
    request.input(key, sql.NVarChar(320), value);
    return `@${key}`;
  }).join(', ');

  const userResult = await request.query<AppUserLookupRow>(
    `SELECT email, azure_oid, last_login, created_at, updated_at
     FROM dbo.[user]
     WHERE is_active = 1
       AND (
         LOWER(email) IN (${emailParams})
         OR email LIKE '%#EXT#@%'
       )`
  );

  const appUserByNormalizedEmail = new Map<string, AppUserLookupRow>();
  for (const appUserRow of userResult.recordset) {
    const normalizedEmail = normalizeEmailForIdentityMatch(appUserRow.email);
    if (!normalizedEmail) {
      continue;
    }

    const existing = appUserByNormalizedEmail.get(normalizedEmail);
    if (!existing || compareAppUserRows(appUserRow, existing) < 0) {
      appUserByNormalizedEmail.set(normalizedEmail, appUserRow);
    }
  }

  return rows.map((row) => {
    if (row.app_user_email || row.app_user_azure_oid || row.app_user_last_login) {
      return row;
    }

    const normalizedMemberEmail = normalizeEmailForIdentityMatch(row.member_email);
    if (!normalizedMemberEmail) {
      return row;
    }

    const matchedAppUser = appUserByNormalizedEmail.get(normalizedMemberEmail);
    if (!matchedAppUser) {
      return row;
    }

    return {
      ...row,
      app_user_email: row.app_user_email ?? matchedAppUser.email,
      app_user_azure_oid: row.app_user_azure_oid ?? matchedAppUser.azure_oid,
      app_user_last_login: row.app_user_last_login ?? matchedAppUser.last_login,
      app_user_created_at: row.app_user_created_at ?? matchedAppUser.created_at,
      app_user_updated_at: row.app_user_updated_at ?? matchedAppUser.updated_at,
      last_sign_in_at: row.last_sign_in_at ?? matchedAppUser.last_login,
    };
  });
}

async function applyFederatedGraphAcceptanceFallback(rows: IdentityStatusJoinedRow[]): Promise<IdentityStatusJoinedRow[]> {
  const candidates = rows.filter((row) => {
    if (!row.member_email) {
      return false;
    }
    if (row.link_status === 'disabled' || row.link_status === 'linked') {
      return false;
    }
    if (row.app_user_email || row.app_user_azure_oid || row.app_user_last_login) {
      return false;
    }
    return true;
  });

  if (candidates.length === 0) {
    return rows;
  }

  const acceptedByMemberId = await getAcceptedByMemberIdFromInviteTrace(candidates.map((candidate) => candidate.member_id));
  const allowGraphLookup = isGraphRoleManagementConfigured();

  for (let index = 0; index < candidates.length; index += IDENTITY_GRAPH_LOOKUP_BATCH_SIZE) {
    const batch = candidates.slice(index, index + IDENTITY_GRAPH_LOOKUP_BATCH_SIZE);
    await Promise.all(batch.map(async (candidate) => {
      if (acceptedByMemberId.has(candidate.member_id.toLowerCase())) {
        return;
      }

      if (!allowGraphLookup) {
        return;
      }

      try {
        const user = await lookupEntraUserByEmail(candidate.member_email);
        if (!user?.id) {
          return;
        }

        const linkedAt = new Date();
        await upsertFederatedGraphLink(candidate.member_id, candidate.member_email, user.id, linkedAt);
        acceptedByMemberId.set(candidate.member_id.toLowerCase(), {
          entraObjectId: user.id,
          linkedAt,
        });
      } catch (error) {
        console.warn('identity status federated graph lookup failed', {
          memberId: candidate.member_id,
          email: candidate.member_email,
          error: error instanceof Error ? error.message : 'unknown_error',
        });
      }
    }));
  }

  if (acceptedByMemberId.size === 0) {
    return rows;
  }

  const acceptedObjectIds = Array.from(new Set(
    Array.from(acceptedByMemberId.values())
      .map((value) => value.entraObjectId)
      .filter((value) => typeof value === 'string' && value.length > 0)
  ));

  const appUserByOid = new Map<string, {
    email: string | null;
    azure_oid: string;
    last_login: Date | null;
    created_at: Date | null;
    updated_at: Date | null;
  }>();

  if (acceptedObjectIds.length > 0) {
    const pool = await getPool();
    const request = pool.request();
    const params = acceptedObjectIds.map((value, index) => {
      const key = `entra_oid_${index}`;
      request.input(key, sql.NVarChar(255), value);
      return `@${key}`;
    }).join(', ');

    const appUserResult = await request.query<{
      email: string | null;
      azure_oid: string;
      last_login: Date | null;
      created_at: Date | null;
      updated_at: Date | null;
    }>(
      `SELECT email, azure_oid, last_login, created_at, updated_at
       FROM dbo.[user]
       WHERE is_active = 1
         AND azure_oid IN (${params})`
    );

    for (const appUserRow of appUserResult.recordset) {
      if (!appUserRow.azure_oid) {
        continue;
      }
      appUserByOid.set(appUserRow.azure_oid.toLowerCase(), appUserRow);
    }
  }

  return rows.map((row) => {
    const accepted = acceptedByMemberId.get(row.member_id.toLowerCase());
    if (!accepted) {
      return row;
    }

    const matchedAppUser = appUserByOid.get(accepted.entraObjectId.toLowerCase());

    return {
      ...row,
      link_status: 'linked',
      identity_provider: row.identity_provider ?? 'federated_graph',
      entra_object_id: row.entra_object_id ?? accepted.entraObjectId,
      issuer_assigned_id: row.issuer_assigned_id ?? row.member_email,
      linked_at: row.linked_at ?? accepted.linkedAt,
      last_sign_in_at: row.last_sign_in_at ?? matchedAppUser?.last_login ?? null,
      app_user_email: row.app_user_email ?? matchedAppUser?.email ?? null,
      app_user_azure_oid: row.app_user_azure_oid ?? matchedAppUser?.azure_oid ?? accepted.entraObjectId,
      app_user_last_login: row.app_user_last_login ?? matchedAppUser?.last_login ?? null,
      app_user_created_at: row.app_user_created_at ?? matchedAppUser?.created_at ?? null,
      app_user_updated_at: row.app_user_updated_at ?? matchedAppUser?.updated_at ?? null,
      link_updated_at: accepted.linkedAt,
    };
  });
}

async function getAcceptedByMemberIdFromInviteTrace(memberIds: string[]): Promise<Map<string, { entraObjectId: string; linkedAt: Date }>> {
  const acceptedByMemberId = new Map<string, { entraObjectId: string; linkedAt: Date }>();
  if (memberIds.length === 0) {
    return acceptedByMemberId;
  }

  const pool = await getPool();
  const request = pool.request();
  const params = memberIds.map((memberId, index) => {
    const key = `trace_member_id_${index}`;
    request.input(key, sql.NVarChar(64), memberId);
    return `@${key}`;
  }).join(', ');

  const traceResult = await request.query<{
    member_id: string;
    invited_user_id: string;
    occurred_at: Date | null;
  }>(
    `IF OBJECT_ID('identity_invite_trace', 'U') IS NULL
     BEGIN
       SELECT TOP 0
         CAST(NULL AS NVARCHAR(64)) AS member_id,
         CAST(NULL AS NVARCHAR(128)) AS invited_user_id,
         CAST(NULL AS DATETIME2(3)) AS occurred_at;
     END
     ELSE
     BEGIN
       SELECT member_id, invited_user_id, occurred_at
       FROM identity_invite_trace
       WHERE invited_user_id IS NOT NULL
         AND member_id IN (${params})
       ORDER BY occurred_at DESC;
     END`
  );

  for (const row of traceResult.recordset) {
    if (!row.member_id || !row.invited_user_id) {
      continue;
    }

    const key = row.member_id.toLowerCase();
    if (acceptedByMemberId.has(key)) {
      continue;
    }

    acceptedByMemberId.set(key, {
      entraObjectId: row.invited_user_id,
      linkedAt: row.occurred_at ?? new Date(),
    });
  }

  return acceptedByMemberId;
}

async function upsertFederatedGraphLink(memberId: string, email: string, entraObjectId: string, linkedAt: Date): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('email', sql.NVarChar(255), email.toLowerCase())
    .input('entra_object_id', sql.NVarChar(255), entraObjectId)
    .input('identity_provider', sql.NVarChar(100), 'federated_graph')
    .input('linked_at', sql.DateTime, linkedAt)
    .query(
      `MERGE member_identity_link AS target
       USING (SELECT @member_id AS member_id) AS source
       ON target.member_id = source.member_id
       WHEN MATCHED THEN
         UPDATE SET
           status = CASE WHEN target.status = 'disabled' THEN target.status ELSE 'linked' END,
           linked_at = COALESCE(target.linked_at, @linked_at),
           entra_object_id = COALESCE(target.entra_object_id, @entra_object_id),
           identity_provider = COALESCE(target.identity_provider, @identity_provider),
           issuer_assigned_id = COALESCE(target.issuer_assigned_id, @email),
           last_seen_email = COALESCE(target.last_seen_email, @email),
           updated_at = GETUTCDATE()
       WHEN NOT MATCHED THEN
         INSERT (
           link_id, member_id, entra_object_id, identity_provider, issuer_assigned_id,
           status, linked_at, last_seen_email, created_at, updated_at
         )
         VALUES (
           NEWID(), @member_id, @entra_object_id, @identity_provider, @email,
           'linked', @linked_at, @email, GETUTCDATE(), GETUTCDATE()
         );`
    );
}

function toIdentityStatusRow(row: IdentityStatusJoinedRow): IdentityStatusRow {
  const hasAppUser = Boolean(
    row.app_user_email
    || row.app_user_azure_oid
    || row.app_user_last_login
    || row.app_user_created_at
  );

  let effectiveStatus: IdentityStatusRow['status'] = 'pending';
  if (row.link_status === 'disabled') {
    effectiveStatus = 'disabled';
  } else if (hasAppUser) {
    effectiveStatus = 'linked';
  } else if (row.link_status) {
    effectiveStatus = row.link_status;
  }

  const linkedAt = row.linked_at ?? (effectiveStatus === 'linked' ? (row.app_user_last_login ?? row.app_user_created_at ?? null) : null);
  const lastSignInAt = row.last_sign_in_at ?? row.app_user_last_login ?? null;

  return {
    member_id: row.member_id,
    status: effectiveStatus,
    identity_provider: row.identity_provider ?? (hasAppUser ? 'app_user' : null),
    entra_object_id: row.entra_object_id ?? row.app_user_azure_oid,
    issuer: row.issuer,
    issuer_assigned_id: row.issuer_assigned_id ?? row.app_user_email,
    invited_at: row.invited_at,
    invite_email_sent_at: row.invite_email_sent_at,
    linked_at: linkedAt,
    last_sign_in_at: lastSignInAt,
    updated_at: row.link_updated_at ?? row.app_user_updated_at ?? row.app_user_created_at,
  };
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

async function upsertMemberIdentityInvite(memberId: string, email: string, invitedBy: string, invitedUserId?: string | null): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('email', sql.NVarChar(255), email)
    .input('invited_by', sql.NVarChar(255), invitedBy)
    .input('invited_user_id', sql.NVarChar(128), invitedUserId ?? null)
    .query(
      `MERGE member_identity_link AS target
       USING (SELECT @member_id AS member_id) AS source
       ON target.member_id = source.member_id
       WHEN MATCHED THEN
         UPDATE SET
           status = CASE WHEN target.status = 'linked' THEN target.status ELSE 'invited' END,
           invited_at = COALESCE(target.invited_at, GETUTCDATE()),
           invite_email_sent_at = GETUTCDATE(),
           entra_object_id = COALESCE(target.entra_object_id, @invited_user_id),
           last_seen_email = COALESCE(target.last_seen_email, @email),
           invited_by = @invited_by,
           updated_at = GETUTCDATE()
       WHEN NOT MATCHED THEN
         INSERT (
           link_id, member_id, entra_object_id, status, invited_at, invite_email_sent_at, last_seen_email,
           invited_by, created_at, updated_at
         )
         VALUES (
           NEWID(), @member_id, @invited_user_id, 'invited', GETUTCDATE(), GETUTCDATE(), @email,
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