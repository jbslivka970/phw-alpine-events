import { Router, Request, Response, NextFunction } from 'express';
import {
  listGroups,
  getGroupById,
  createGroup,
  updateGroup,
  deleteGroup,
  getGroupMembers,
  addMemberToGroup,
  removeMemberFromGroup,
  CreateGroupInput,
  UpdateGroupInput,
} from '../services/groupService';
import { getMemberById } from '../services/memberService';

const router = Router();

// GET /api/v1/groups
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const groups = await listGroups();
    res.json(groups);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/groups/:id
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await getGroupById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found.' });
    return res.json(group);
  } catch (err) {
    return next(err);
  }
});

// GET /api/v1/groups/:id/members
router.get('/:id/members', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await getGroupById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found.' });
    const memberIds = await getGroupMembers(req.params.id);
    res.json(memberIds);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/groups
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: CreateGroupInput = req.body;
    if (!input.name) {
      return res.status(400).json({ error: 'name is required.' });
    }
    const group = await createGroup(input);
    return res.status(201).json(group);
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/v1/groups/:id
router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input: UpdateGroupInput = req.body;
    const group = await updateGroup(req.params.id, input);
    if (!group) return res.status(404).json({ error: 'Group not found.' });
    return res.json(group);
  } catch (err: unknown) {
    if (isHttpError(err, 403)) return res.status(403).json({ error: (err as Error).message });
    return next(err);
  }
});

// DELETE /api/v1/groups/:id
router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await deleteGroup(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Group not found.' });
    return res.json({ message: 'Group deleted.' });
  } catch (err: unknown) {
    if (isHttpError(err, 403)) return res.status(403).json({ error: (err as Error).message });
    return next(err);
  }
});

// POST /api/v1/groups/:id/members/:memberId
router.post('/:id/members/:memberId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await getGroupById(req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found.' });

    const member = await getMemberById(req.params.memberId);
    if (!member) return res.status(404).json({ error: 'Member not found.' });

    await addMemberToGroup(req.params.memberId, req.params.id);
    return res.status(201).json({ message: 'Member added to group.' });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/v1/groups/:id/members/:memberId
router.delete('/:id/members/:memberId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const removed = await removeMemberFromGroup(req.params.memberId, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Membership not found.' });
    return res.json({ message: 'Member removed from group.' });
  } catch (err) {
    return next(err);
  }
});

function isHttpError(err: unknown, statusCode: number): boolean {
  return err instanceof Error && (err as Error & { statusCode?: number }).statusCode === statusCode;
}

export default router;
