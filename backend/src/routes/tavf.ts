import { Router, Request, Response } from 'express';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireEventCreatorOrAdmin, requireTavfCreator } from '../middleware/rbac';
import * as tavf from '../services/tavfService';
import { getPool, sql } from '../db';
import { DEFAULT_TENANT_ID } from '../middleware/resolveTenantContext';
import { invalidateShortLivedCache, withShortLivedCache } from '../services/shortLivedCache';

const router = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parsePositiveIntQuery(value: unknown, max: number): number | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }

  return Math.min(parsed, max);
}

const DASHBOARD_CACHE_TTL_MS = 20_000;

type TavfTenantScope = {
  apply: boolean;
  tenantId: string;
};

type TavfTenantSupport = {
  hasPostingTenantColumn: boolean;
  hasTenantMembershipTable: boolean;
};

let cachedTavfTenantSupport: TavfTenantSupport | null = null;

function isMultiTenantEnabled(): boolean {
  const raw = process.env['MULTI_TENANT_ENABLED'];
  if (!raw) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

async function getTavfTenantSupport(pool: Awaited<ReturnType<typeof getPool>>): Promise<TavfTenantSupport> {
  if (cachedTavfTenantSupport) {
    return cachedTavfTenantSupport;
  }

  const result = await pool
    .request()
    .query<{ has_posting_tenant_column: number; has_tenant_membership_table: number }>(
      `SELECT
          CASE WHEN COL_LENGTH('dbo.tavf_posting', 'tenant_id') IS NULL THEN 0 ELSE 1 END AS has_posting_tenant_column,
          CASE WHEN OBJECT_ID('dbo.tenant_membership', 'U') IS NULL THEN 0 ELSE 1 END AS has_tenant_membership_table`
    );

  cachedTavfTenantSupport = {
    hasPostingTenantColumn: result.recordset[0]?.has_posting_tenant_column === 1,
    hasTenantMembershipTable: result.recordset[0]?.has_tenant_membership_table === 1,
  };

  return cachedTavfTenantSupport;
}

async function resolveTavfTenantScope(req: Request, pool: Awaited<ReturnType<typeof getPool>>): Promise<TavfTenantScope> {
  const tenantId = (req.tenantId ?? DEFAULT_TENANT_ID).trim().toLowerCase();
  if (!isMultiTenantEnabled()) {
    return { apply: false, tenantId };
  }

  const support = await getTavfTenantSupport(pool);
  return {
    apply: support.hasPostingTenantColumn,
    tenantId,
  };
}

function activeTenantMembershipPredicate(memberIdExpression: string): string {
  return `EXISTS (
    SELECT 1
    FROM dbo.tenant_membership tm
    WHERE tm.member_id = ${memberIdExpression}
      AND tm.tenant_id = @tenant_id
      AND tm.status = 'active'
      AND tm.revoked_at IS NULL
      AND tm.starts_at <= GETUTCDATE()
      AND (tm.expires_at IS NULL OR tm.expires_at > GETUTCDATE())
  )`;
}

async function ensurePostingTenantAccess(
  req: Request,
  res: Response,
  pool: Awaited<ReturnType<typeof getPool>>,
  postingId: string,
): Promise<boolean> {
  const tenantScope = await resolveTavfTenantScope(req, pool);
  if (!tenantScope.apply) {
    return true;
  }

  const result = await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, postingId)
    .input('tenant_id', sql.UniqueIdentifier, tenantScope.tenantId)
    .query<{ posting_id: string }>(
      `SELECT TOP 1 p.posting_id
       FROM dbo.tavf_posting p
       WHERE p.posting_id = @posting_id
         AND p.tenant_id = @tenant_id`
    );

  if (!result.recordset[0]) {
    res.status(404).json({ error: 'Posting not found' });
    return false;
  }

  return true;
}

async function ensureApplicationTenantAccess(
  req: Request,
  res: Response,
  pool: Awaited<ReturnType<typeof getPool>>,
  applicationId: string,
): Promise<boolean> {
  const tenantScope = await resolveTavfTenantScope(req, pool);
  if (!tenantScope.apply) {
    return true;
  }

  const result = await pool
    .request()
    .input('application_id', sql.UniqueIdentifier, applicationId)
    .input('tenant_id', sql.UniqueIdentifier, tenantScope.tenantId)
    .query<{ application_id: string }>(
      `SELECT TOP 1 a.application_id
       FROM dbo.tavf_application a
       WHERE a.application_id = @application_id
         AND a.tenant_id = @tenant_id`
    );

  if (!result.recordset[0]) {
    res.status(404).json({ error: 'Application not found' });
    return false;
  }

  return true;
}

async function ensureMatchTenantAccess(
  req: Request,
  res: Response,
  pool: Awaited<ReturnType<typeof getPool>>,
  matchId: string,
): Promise<boolean> {
  const tenantScope = await resolveTavfTenantScope(req, pool);
  if (!tenantScope.apply) {
    return true;
  }

  const result = await pool
    .request()
    .input('match_id', sql.UniqueIdentifier, matchId)
    .input('tenant_id', sql.UniqueIdentifier, tenantScope.tenantId)
    .query<{ match_id: string }>(
      `SELECT TOP 1 tm.match_id
       FROM dbo.tavf_match tm
       WHERE tm.match_id = @match_id
         AND tm.tenant_id = @tenant_id`
    );

  if (!result.recordset[0]) {
    res.status(404).json({ error: 'Match not found' });
    return false;
  }

  return true;
}

async function ensureMemberInTenant(
  req: Request,
  res: Response,
  pool: Awaited<ReturnType<typeof getPool>>,
  memberId: string,
  notFoundMessage: string,
): Promise<boolean> {
  const tenantScope = await resolveTavfTenantScope(req, pool);
  const support = await getTavfTenantSupport(pool);
  if (!tenantScope.apply || !support.hasTenantMembershipTable) {
    return true;
  }

  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .input('tenant_id', sql.UniqueIdentifier, tenantScope.tenantId)
    .query<{ member_id: string }>(
      `SELECT TOP 1 member_id
       FROM dbo.member m
       WHERE m.member_id = @member_id
         AND ${activeTenantMembershipPredicate('m.member_id')}`
    );

  if (!result.recordset[0]) {
    res.status(404).json({ error: notFoundMessage });
    return false;
  }

  return true;
}

function isSchemaAvailabilityError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes('invalid object name')
    || message.includes('create table permission denied')
    || message.includes('permission was denied on object');
}

function splitDisplayName(name: string | undefined, fallbackEmail: string): { firstName: string; lastName: string } {
  const base = (name ?? '').trim();
  if (!base || base.includes('@')) {
    const localPart = fallbackEmail.split('@')[0] ?? 'member';
    return { firstName: localPart.slice(0, 80), lastName: 'Member' };
  }

  const pieces = base.split(/\s+/).filter(Boolean);
  if (pieces.length === 1) {
    return { firstName: pieces[0]!.slice(0, 80), lastName: 'Member' };
  }

  return {
    firstName: (pieces.shift() ?? 'Member').slice(0, 80),
    lastName: pieces.join(' ').slice(0, 80) || 'Member',
  };
}

async function resolveGuideMemberId(
  user: Request['user']
): Promise<string | null> {
  const pool = await getPool();

  const email = user?.email?.trim().toLowerCase();
  if (!email) {
    return null;
  }

  const byEmail = await pool
    .request()
    .input('email', sql.NVarChar(320), email)
    .query<{ member_id: string }>('SELECT TOP 1 member_id FROM member WHERE LOWER(email) = @email ORDER BY is_active DESC, updated_at DESC');

  if ((byEmail.recordset[0]?.member_id ?? '').length > 0) {
    return byEmail.recordset[0]!.member_id;
  }

  const { firstName, lastName } = splitDisplayName(user?.name, email);

  try {
    const created = await pool
      .request()
      .input('first_name', sql.NVarChar(100), firstName)
      .input('last_name', sql.NVarChar(100), lastName)
      .input('email', sql.NVarChar(320), email)
      .query<{ member_id: string }>(
        `INSERT INTO member
           (first_name, last_name, email, mobile_phone, sms_opt_in, email_opt_out, source)
         OUTPUT INSERTED.member_id
         VALUES
           (@first_name, @last_name, @email, NULL, 0, 0, 'manual')`
      );

    return created.recordset[0]?.member_id ?? null;
  } catch {
    const raced = await pool
      .request()
      .input('email', sql.NVarChar(320), email)
      .query<{ member_id: string }>('SELECT TOP 1 member_id FROM member WHERE LOWER(email) = @email ORDER BY is_active DESC, updated_at DESC');
    return raced.recordset[0]?.member_id ?? null;
  }
}

async function resolveCurrentMemberId(user: Request['user']): Promise<string | null> {
  return resolveGuideMemberId(user);
}

function hasElevatedTavfAccess(user: Request['user']): boolean {
  return Boolean(user?.roles.includes('ADMIN') || user?.roles.includes('EVENT_CREATOR'));
}

// All TAVF routes require authentication
router.use(apiLimiter);
router.use(authenticate);
router.use((req, _res, next) => {
  if (req.method !== 'GET') {
    invalidateShortLivedCache('tavf:postings:');
  }
  next();
});

// ---------------------------------------------------------------------------
// Postings
// ---------------------------------------------------------------------------

/**
 * GET /api/tavf/postings
 * Query params: status (open|filled|cancelled)
 */
router.get('/postings', apiLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const status = req.query['status'] as tavf.PostingStatus | undefined;
    const limit = parsePositiveIntQuery(req.query['limit'], 50);
    if (!isMultiTenantEnabled()) {
      const cacheKey = [
        'tavf:postings',
        `status=${status ?? 'all'}`,
        `limit=${limit ?? 'all'}`,
        'tenant=legacy',
      ].join(':');
      const postings = await withShortLivedCache(cacheKey, DASHBOARD_CACHE_TTL_MS, async () => {
        return tavf.listPostings({
          ...(status ? { status } : {}),
          ...(limit ? { limit } : {}),
        });
      });

      res.json(postings);
      return;
    }

    const pool = await getPool();
    const tenantScope = await resolveTavfTenantScope(req, pool);
    const cacheKey = [
      'tavf:postings',
      `status=${status ?? 'all'}`,
      `limit=${limit ?? 'all'}`,
      `tenant=${tenantScope.apply ? tenantScope.tenantId : 'legacy'}`,
    ].join(':');
    const postings = await withShortLivedCache(cacheKey, DASHBOARD_CACHE_TTL_MS, async () => {
      const allPostings = await tavf.listPostings({
        ...(status ? { status } : {}),
        ...(limit ? { limit } : {}),
        ...(tenantScope.apply ? { tenantId: tenantScope.tenantId } : {}),
      });
      return allPostings;
    });

    res.json(postings);
    return;
  } catch (err) {
    if (isSchemaAvailabilityError(err)) {
      console.warn('[tavf] listPostings schema unavailable; returning empty list', err);
      res.json([]);
      return;
    }
    console.error('[tavf] listPostings unexpected error; returning empty list', err);
    res.json([]);
  }
});

/**
 * GET /api/tavf/postings/:id
 */
router.get('/postings/:id', apiLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    if (isMultiTenantEnabled()) {
      const pool = await getPool();
      if (!(await ensurePostingTenantAccess(req, res, pool, req.params['id']!))) {
        return;
      }
    }
    const posting = await tavf.getPosting(req.params['id']!);
    if (!posting) {
      res.status(404).json({ error: 'Posting not found' });
      return;
    }
    res.json(posting);
  } catch (err) {
    console.error('[tavf] getPosting error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/tavf/postings
 * Body: CreatePostingInput
 */
router.post('/postings', writeLimiter, requireTavfCreator, async (req: Request, res: Response): Promise<void> => {
  try {
    const multiTenantEnabled = isMultiTenantEnabled();
    const pool = multiTenantEnabled ? await getPool() : null;
    const tenantScope = pool ? await resolveTavfTenantScope(req, pool) : { apply: false, tenantId: (req.tenantId ?? DEFAULT_TENANT_ID).trim().toLowerCase() };
    const { guide_member_id, event_date, location, capacity, species, description } = req.body as Partial<tavf.CreatePostingInput>;
    if (!event_date || !location || !capacity) {
      res.status(400).json({ error: 'event_date, location, and capacity are required' });
      return;
    }

    let resolvedGuideMemberId: string | null = null;
    if (typeof guide_member_id === 'string' && guide_member_id.trim().length > 0) {
      if (UUID_PATTERN.test(guide_member_id)) {
        resolvedGuideMemberId = guide_member_id;
      } else {
        // Backward compatibility: older clients may send auth subject/local account IDs.
        // If so, derive the guide member from authenticated identity instead of failing.
        resolvedGuideMemberId = await resolveGuideMemberId(req.user);
      }
    } else {
      resolvedGuideMemberId = await resolveGuideMemberId(req.user);
    }

    if (!resolvedGuideMemberId) {
      res.status(400).json({ error: 'Unable to resolve a member profile for this authenticated user.' });
      return;
    }

    if (multiTenantEnabled && pool) {
      if (!(await ensureMemberInTenant(req, res, pool, resolvedGuideMemberId, 'Guide member profile not found for active tenant.'))) {
        return;
      }
    }

    const posting = await tavf.createPosting({
      tenant_id: tenantScope.tenantId,
      guide_member_id: resolvedGuideMemberId,
      event_date,
      location,
      capacity,
      species,
      description,
    });
    res.status(201).json(posting);
  } catch (err) {
    if (err instanceof Error && err.message.toLowerCase().includes('fk_tavf_posting_guide')) {
      res.status(400).json({ error: 'Guide member profile is invalid or missing.' });
      return;
    }
    console.error('[tavf] createPosting error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/tavf/postings/:id
 * Body: UpdatePostingInput
 */
router.patch('/postings/:id', writeLimiter, requireEventCreatorOrAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    if (isMultiTenantEnabled()) {
      const pool = await getPool();
      if (!(await ensurePostingTenantAccess(req, res, pool, req.params['id']!))) {
        return;
      }
    }
    const updated = await tavf.updatePosting(req.params['id']!, req.body as tavf.UpdatePostingInput);
    if (!updated) {
      res.status(404).json({ error: 'Posting not found' });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error('[tavf] updatePosting error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/tavf/postings/:id
 */
router.delete('/postings/:id', writeLimiter, requireEventCreatorOrAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    if (isMultiTenantEnabled()) {
      const pool = await getPool();
      if (!(await ensurePostingTenantAccess(req, res, pool, req.params['id']!))) {
        return;
      }
    }
    const deleted = await tavf.deletePosting(req.params['id']!);
    if (!deleted) {
      res.status(404).json({ error: 'Posting not found' });
      return;
    }
    res.status(204).send();
  } catch (err) {
    console.error('[tavf] deletePosting error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Applications (scoped under a posting)
// ---------------------------------------------------------------------------

/**
 * GET /api/tavf/postings/:id/applications
 */
router.get('/postings/:id/applications', apiLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    if (isMultiTenantEnabled()) {
      const pool = await getPool();
      if (!(await ensurePostingTenantAccess(req, res, pool, req.params['id']!))) {
        return;
      }
    }
    const applications = await tavf.listApplicationsForPosting(req.params['id']!);
    if (hasElevatedTavfAccess(req.user)) {
      res.json(applications);
      return;
    }

    const memberId = await resolveCurrentMemberId(req.user);
    if (!memberId) {
      res.json([]);
      return;
    }

    res.json(applications.filter((application) => application.vet_member_id === memberId));
  } catch (err) {
    console.error('[tavf] listApplications error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/tavf/postings/:id/applications
 * Body: { vet_member_id, notes? }
 */
router.post('/postings/:id/applications', writeLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const multiTenantEnabled = isMultiTenantEnabled();
    const pool = multiTenantEnabled ? await getPool() : null;
    const tenantScope = pool ? await resolveTavfTenantScope(req, pool) : { apply: false, tenantId: (req.tenantId ?? DEFAULT_TENANT_ID).trim().toLowerCase() };
    if (multiTenantEnabled && pool) {
      if (!(await ensurePostingTenantAccess(req, res, pool, req.params['id']!))) {
        return;
      }
    }
    const { vet_member_id: requestedVetMemberId, notes } = req.body as { vet_member_id?: string; notes?: string };
    const elevatedAccess = hasElevatedTavfAccess(req.user);
    const resolveCurrentMemberIdSafe = async (): Promise<string | null> => {
      try {
        return await resolveCurrentMemberId(req.user);
      } catch (error) {
        console.warn('[tavf] resolveCurrentMemberId failed in createApplication', error);
        return null;
      }
    };

    let vetMemberId = requestedVetMemberId;

    if (!elevatedAccess) {
      const currentMemberId = await resolveCurrentMemberIdSafe();
      if (!currentMemberId) {
        res.status(400).json({ error: 'Unable to resolve a member profile for this authenticated user.' });
        return;
      }

      if (requestedVetMemberId && requestedVetMemberId !== currentMemberId) {
        res.status(403).json({ error: 'You can only create an application for your own member profile.' });
        return;
      }

      vetMemberId = currentMemberId;
    } else if (!vetMemberId) {
      const currentMemberId = await resolveCurrentMemberIdSafe();
      vetMemberId = currentMemberId ?? undefined;
    }

    if (!vetMemberId) {
      res.status(400).json({ error: 'vet_member_id is required' });
      return;
    }

    if (multiTenantEnabled && pool) {
      if (!(await ensureMemberInTenant(req, res, pool, vetMemberId, 'Member profile not found for active tenant.'))) {
        return;
      }
    }

    const application = await tavf.createApplication({
      tenant_id: tenantScope.tenantId,
      posting_id: req.params['id']!,
      vet_member_id: vetMemberId,
      notes,
    });
    res.status(201).json(application);
  } catch (err) {
    if (err instanceof Error && err.message.includes('closed and no longer accepting applications')) {
      res.status(409).json({ error: err.message });
      return;
    }

    if (err && typeof err === 'object') {
      const sqlErr = err as { number?: number };
      if (sqlErr.number === 2601 || sqlErr.number === 2627) {
        res.status(409).json({ error: 'You have already applied to this posting.' });
        return;
      }
    }

    console.error('[tavf] createApplication error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/tavf/applications/:id
 */
router.get('/applications/:id', apiLimiter, requireEventCreatorOrAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    if (isMultiTenantEnabled()) {
      const pool = await getPool();
      if (!(await ensureApplicationTenantAccess(req, res, pool, req.params['id']!))) {
        return;
      }
    }
    const application = await tavf.getApplication(req.params['id']!);
    if (!application) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    res.json(application);
  } catch (err) {
    console.error('[tavf] getApplication error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * PATCH /api/tavf/applications/:id/status
 * Body: { status: ApplicationStatus }
 */
router.patch('/applications/:id/status', writeLimiter, requireEventCreatorOrAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    if (isMultiTenantEnabled()) {
      const pool = await getPool();
      if (!(await ensureApplicationTenantAccess(req, res, pool, req.params['id']!))) {
        return;
      }
    }
    const { status } = req.body as { status: tavf.ApplicationStatus };
    if (!status) {
      res.status(400).json({ error: 'status is required' });
      return;
    }
    const updated = await tavf.updateApplicationStatus(req.params['id']!, status);
    if (!updated) {
      res.status(404).json({ error: 'Application not found' });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error('[tavf] updateApplicationStatus error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Matches
// ---------------------------------------------------------------------------

/**
 * GET /api/tavf/matches
 * Returns all matches (admin/event creator use).
 */
router.get('/matches', apiLimiter, requireEventCreatorOrAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    if (!isMultiTenantEnabled()) {
      const postings = await tavf.listPostings();
      const postingIds = postings.map((posting) => posting.posting_id);
      const allMatches = await Promise.all(postingIds.map((postingId) => tavf.listMatchesForPosting(postingId)));
      res.json(allMatches.flat());
      return;
    }

    const pool = await getPool();
    const tenantScope = await resolveTavfTenantScope(req, pool);
    const postings = await tavf.listPostings({ ...(tenantScope.apply ? { tenantId: tenantScope.tenantId } : {}) });
    const postingIds = postings.map((posting) => posting.posting_id);
    const allMatches = await Promise.all(postingIds.map((postingId) => tavf.listMatchesForPosting(postingId)));
    res.json(allMatches.flat());
  } catch (err) {
    console.error('[tavf] listAllMatches error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/tavf/postings/:id/matches
 */
router.get('/postings/:id/matches', apiLimiter, requireEventCreatorOrAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    if (isMultiTenantEnabled()) {
      const pool = await getPool();
      if (!(await ensurePostingTenantAccess(req, res, pool, req.params['id']!))) {
        return;
      }
    }
    const matches = await tavf.listMatchesForPosting(req.params['id']!);
    res.json(matches);
  } catch (err) {
    console.error('[tavf] listMatches error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/tavf/matches
 * Body: CreateMatchInput
 */
router.post('/matches', writeLimiter, requireEventCreatorOrAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    const multiTenantEnabled = isMultiTenantEnabled();
    const pool = multiTenantEnabled ? await getPool() : null;
    const tenantScope = pool ? await resolveTavfTenantScope(req, pool) : { apply: false, tenantId: (req.tenantId ?? DEFAULT_TENANT_ID).trim().toLowerCase() };
    const { posting_id, application_id, matched_by, notes } = req.body as tavf.CreateMatchInput;
    if (!posting_id || !application_id) {
      res.status(400).json({ error: 'posting_id and application_id are required' });
      return;
    }

    if (multiTenantEnabled && pool) {
      if (!(await ensurePostingTenantAccess(req, res, pool, posting_id))) {
        return;
      }

      if (!(await ensureApplicationTenantAccess(req, res, pool, application_id))) {
        return;
      }

      if (typeof matched_by === 'string' && UUID_PATTERN.test(matched_by)) {
        const isInTenant = await ensureMemberInTenant(req, res, pool, matched_by, 'Match operator not found for active tenant.');
        if (!isInTenant) {
          return;
        }
      }
    }

    const match = await tavf.createMatch({ posting_id, application_id, matched_by, notes, tenant_id: tenantScope.tenantId });
    res.status(201).json(match);
  } catch (err) {
    console.error('[tavf] createMatch error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/tavf/matches/:id
 */
router.get('/matches/:id', apiLimiter, requireEventCreatorOrAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    if (isMultiTenantEnabled()) {
      const pool = await getPool();
      if (!(await ensureMatchTenantAccess(req, res, pool, req.params['id']!))) {
        return;
      }
    }
    const match = await tavf.getMatch(req.params['id']!);
    if (!match) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }
    res.json(match);
  } catch (err) {
    console.error('[tavf] getMatch error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * DELETE /api/tavf/matches/:id
 * Cancels the match (does not hard-delete)
 */
router.delete('/matches/:id', writeLimiter, requireEventCreatorOrAdmin, async (req: Request, res: Response): Promise<void> => {
  try {
    if (isMultiTenantEnabled()) {
      const pool = await getPool();
      if (!(await ensureMatchTenantAccess(req, res, pool, req.params['id']!))) {
        return;
      }
    }
    const updated = await tavf.cancelMatch(req.params['id']!);
    if (!updated) {
      res.status(404).json({ error: 'Match not found' });
      return;
    }
    res.json(updated);
  } catch (err) {
    console.error('[tavf] cancelMatch error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/subscription/me', apiLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const multiTenantEnabled = isMultiTenantEnabled();
    const pool = multiTenantEnabled ? await getPool() : null;
    const memberId = await resolveCurrentMemberId(req.user);
    if (!memberId) {
      res.status(404).json({ error: 'No member profile found for authenticated account.' });
      return;
    }

    if (multiTenantEnabled && pool) {
      if (!(await ensureMemberInTenant(req, res, pool, memberId, 'No member profile found for active tenant.'))) {
        return;
      }
    }

    const subscription = await tavf.getNotificationSubscription(memberId);
    res.json(subscription);
  } catch (err) {
    console.error('[tavf] getSubscription error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.put('/subscription/me', writeLimiter, async (req: Request, res: Response): Promise<void> => {
  try {
    const multiTenantEnabled = isMultiTenantEnabled();
    const pool = multiTenantEnabled ? await getPool() : null;
    const memberId = await resolveCurrentMemberId(req.user);
    if (!memberId) {
      res.status(404).json({ error: 'No member profile found for authenticated account.' });
      return;
    }

    if (multiTenantEnabled && pool) {
      if (!(await ensureMemberInTenant(req, res, pool, memberId, 'No member profile found for active tenant.'))) {
        return;
      }
    }

    const isSubscribed = req.body?.is_subscribed;
    if (typeof isSubscribed !== 'boolean') {
      res.status(400).json({ error: 'is_subscribed must be a boolean.' });
      return;
    }

    const source = typeof req.body?.source === 'string' && req.body.source.trim().length > 0
      ? req.body.source.trim().slice(0, 30)
      : 'preferences';

    const subscription = await tavf.upsertNotificationSubscription(memberId, isSubscribed, source);
    res.json(subscription);
  } catch (err) {
    console.error('[tavf] updateSubscription error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
