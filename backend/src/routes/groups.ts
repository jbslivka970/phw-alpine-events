import { NextFunction, Request, Response, Router } from 'express';
import authenticate from '../middleware/auth';
import { apiLimiter, writeLimiter } from '../middleware/rateLimiter';
import { requireAdmin, requireAnyAuthenticatedRole } from '../middleware/rbac';
import {
  addMemberToGroup,
  createGroup,
  deleteGroup,
  getGroupById,
  getGroupMembers,
  removeMemberFromGroup,
  listGroups,
  updateGroup,
} from '../services/groupService';
import { getMemberById } from '../services/memberService';

const router = Router();

router.get('/', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const groups = await listGroups();
    res.json(groups);
  } catch (error) {
    next(error);
  }
});

router.get('/:id', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await getGroupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'Group not found.' });
      return;
    }
    res.json(group);
  } catch (error) {
    next(error);
  }
});

router.get('/:id/members', apiLimiter, authenticate, requireAnyAuthenticatedRole, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await getGroupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'Group not found.' });
      return;
    }
    const memberIds = await getGroupMembers(req.params.id);
    res.json(memberIds);
  } catch (error) {
    next(error);
  }
});

router.post('/', writeLimiter, authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const groupName = req.body?.group_name;
    if (!groupName || typeof groupName !== 'string') {
      res.status(400).json({ error: 'group_name is required.' });
      return;
    }

    const group = await createGroup({
      group_name: groupName,
      description: typeof req.body?.description === 'string' ? req.body.description : null,
    });

    res.status(201).json(group);
  } catch (error) {
    next(error);
  }
});

router.patch('/:id', writeLimiter, authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await updateGroup(req.params.id, {
      group_name: typeof req.body?.group_name === 'string' ? req.body.group_name : undefined,
      description: 'description' in req.body ? (typeof req.body.description === 'string' ? req.body.description : null) : undefined,
    });

    if (!group) {
      res.status(404).json({ error: 'Group not found.' });
      return;
    }

    res.json(group);
  } catch (error: unknown) {
    if (isHttpError(error, 403)) {
      res.status(403).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.delete('/:id', writeLimiter, authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deleted = await deleteGroup(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Group not found.' });
      return;
    }

    res.json({ message: 'Group deleted.' });
  } catch (error: unknown) {
    if (isHttpError(error, 403)) {
      res.status(403).json({ error: error.message });
      return;
    }
    next(error);
  }
});

router.post('/:id/members/:memberId', writeLimiter, authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const group = await getGroupById(req.params.id);
    if (!group) {
      res.status(404).json({ error: 'Group not found.' });
      return;
    }

    const member = await getMemberById(req.params.memberId);
    if (!member) {
      res.status(404).json({ error: 'Member not found.' });
      return;
    }

    await addMemberToGroup(req.params.memberId, req.params.id);
    res.status(201).json({ message: 'Member added to group.' });
  } catch (error) {
    next(error);
  }
});

router.delete('/:id/members/:memberId', writeLimiter, authenticate, requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const removed = await removeMemberFromGroup(req.params.memberId, req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Membership not found.' });
      return;
    }

    res.json({ message: 'Member removed from group.' });
  } catch (error) {
    next(error);
  }
});

function isHttpError(error: unknown, statusCode: number): error is Error & { statusCode?: number } {
  return error instanceof Error && (error as Error & { statusCode?: number }).statusCode === statusCode;
}

export default router;