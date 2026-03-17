import { Router, Request, Response, NextFunction } from 'express';
import {
  listMembers,
  getMemberById,
  createMember,
  updateMember,
  deactivateMember,
  CreateMemberInput,
  UpdateMemberInput,
} from '../services/memberService';
import { getMemberGroups } from '../services/groupService';

const router = Router();

// GET /api/v1/members
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page     = parseInt((req.query.page     as string) || '1',  10);
    const pageSize = parseInt((req.query.pageSize as string) || '50', 10);
    const search   = (req.query.search   as string) || undefined;
    const isActiveRaw = req.query.isActive as string | undefined;
    const isActive = isActiveRaw === undefined ? undefined : isActiveRaw !== 'false';

    const result = await listMembers({ page, pageSize, search, isActive });
    res.json({ ...result, page, pageSize });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/members/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const member = await getMemberById(req.params.id);
    if (!member) return res.status(404).json({ error: 'Member not found.' });
    return res.json(member);
  } catch (err) {
    return next(err);
  }
});

// GET /api/v1/members/:id/groups
router.get('/:id/groups', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const groups = await getMemberGroups(req.params.id);
    res.json(groups);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/members
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: CreateMemberInput = req.body;

    if (!input.first_name || !input.last_name || !input.email) {
      return res.status(400).json({ error: 'first_name, last_name, and email are required.' });
    }

    const member = await createMember(input);
    return res.status(201).json(member);
  } catch (err: unknown) {
    if (isHttpError(err, 409)) return res.status(409).json({ error: (err as Error).message });
    return next(err);
  }
});

// PATCH /api/v1/members/:id
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: UpdateMemberInput = req.body;
    const member = await updateMember(req.params.id, input);
    if (!member) return res.status(404).json({ error: 'Member not found.' });
    return res.json(member);
  } catch (err: unknown) {
    if (isHttpError(err, 409)) return res.status(409).json({ error: (err as Error).message });
    return next(err);
  }
});

// DELETE /api/v1/members/:id  (soft-delete / deactivate)
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const member = await deactivateMember(req.params.id);
    if (!member) return res.status(404).json({ error: 'Member not found.' });
    return res.json({ message: 'Member deactivated.', member });
  } catch (err) {
    return next(err);
  }
});

function isHttpError(err: unknown, statusCode: number): boolean {
  return err instanceof Error && (err as Error & { statusCode?: number }).statusCode === statusCode;
}

export default router;
