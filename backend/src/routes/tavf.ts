import { Router, Request, Response } from 'express';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAnyAuthenticatedRole, requireEventCreatorOrAdmin, requireTavfCreator } from '../middleware/rbac';
import * as tavf from '../services/tavfService';

const router = Router();

// All TAVF routes require authentication
router.use(authenticate);
router.use(requireAnyAuthenticatedRole);

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
    console.error('[tavf] listPostings error', err);
    res.status(500).json({ error: 'Internal server error' });
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
    const { guide_member_id, event_date, location, capacity, species, description } = req.body as tavf.CreatePostingInput;
    if (!guide_member_id || !event_date || !location || !capacity) {
      res.status(400).json({ error: 'guide_member_id, event_date, location, and capacity are required' });
      return;
    }
    const posting = await tavf.createPosting({ guide_member_id, event_date, location, capacity, species, description });
    res.status(201).json(posting);
  } catch (err) {
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
