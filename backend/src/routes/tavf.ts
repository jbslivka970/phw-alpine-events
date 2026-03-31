import { Router, Request, Response } from 'express';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireEventCreatorOrAdmin, requireTavfCreator } from '../middleware/rbac';
import * as tavf from '../services/tavfService';
import { getPool, sql } from '../db';

const router = Router();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  if (!base) {
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

// All TAVF routes require authentication
router.use(authenticate);

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
    const postings = await tavf.listPostings(status ? { status } : {});
    res.json(postings);
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

    const posting = await tavf.createPosting({
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
router.delete('/postings/:id', async (req: Request, res: Response): Promise<void> => {
  try {
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
router.get('/postings/:id/applications', async (req: Request, res: Response): Promise<void> => {
  try {
    const applications = await tavf.listApplicationsForPosting(req.params['id']!);
    res.json(applications);
  } catch (err) {
    console.error('[tavf] listApplications error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/tavf/postings/:id/applications
 * Body: { vet_member_id, notes? }
 */
router.post('/postings/:id/applications', async (req: Request, res: Response): Promise<void> => {
  try {
    const { vet_member_id, notes } = req.body as { vet_member_id: string; notes?: string };
    if (!vet_member_id) {
      res.status(400).json({ error: 'vet_member_id is required' });
      return;
    }
    const application = await tavf.createApplication({
      posting_id: req.params['id']!,
      vet_member_id,
      notes,
    });
    res.status(201).json(application);
  } catch (err) {
    console.error('[tavf] createApplication error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/tavf/applications/:id
 */
router.get('/applications/:id', async (req: Request, res: Response): Promise<void> => {
  try {
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
router.patch('/applications/:id/status', async (req: Request, res: Response): Promise<void> => {
  try {
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
router.get('/matches', apiLimiter, requireEventCreatorOrAdmin, async (_req: Request, res: Response): Promise<void> => {
  try {
    const postings = await tavf.listPostings();
    const allMatches = await Promise.all(postings.map((posting) => tavf.listMatchesForPosting(posting.posting_id)));
    res.json(allMatches.flat());
  } catch (err) {
    console.error('[tavf] listAllMatches error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/tavf/postings/:id/matches
 */
router.get('/postings/:id/matches', async (req: Request, res: Response): Promise<void> => {
  try {
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
router.post('/matches', async (req: Request, res: Response): Promise<void> => {
  try {
    const { posting_id, application_id, matched_by, notes } = req.body as tavf.CreateMatchInput;
    if (!posting_id || !application_id) {
      res.status(400).json({ error: 'posting_id and application_id are required' });
      return;
    }
    const match = await tavf.createMatch({ posting_id, application_id, matched_by, notes });
    res.status(201).json(match);
  } catch (err) {
    console.error('[tavf] createMatch error', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/tavf/matches/:id
 */
router.get('/matches/:id', async (req: Request, res: Response): Promise<void> => {
  try {
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
router.delete('/matches/:id', async (req: Request, res: Response): Promise<void> => {
  try {
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

export default router;
