import express from 'express';
import request from 'supertest';
import groupsRouter from '../routes/groups';
import * as groupService from '../services/groupService';
import * as memberService from '../services/memberService';

jest.mock('../services/groupService');
jest.mock('../services/memberService');

jest.mock('../middleware/auth', () => ({
  __esModule: true,
  default: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const headerRoles = (req.headers['x-test-roles'] as string | undefined) ?? 'ADMIN';
    req.user = {
      sub: '00000000-0000-0000-0000-000000000001',
      email: 'admin@example.com',
      roles: headerRoles.split(',') as ('ADMIN' | 'EVENT_CREATOR' | 'USER')[],
      rawClaims: {},
    };
    next();
  },
}));

jest.mock('../middleware/rateLimiter', () => ({
  apiLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  writeLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

describe('groups routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/groups', groupsRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/groups returns group list', async () => {
    (groupService.listGroups as jest.Mock).mockResolvedValue([
      { group_id: 'group-1', group_name: 'Mentors', description: null, is_system: false },
    ]);

    const res = await request(app).get('/api/groups');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('POST /api/groups validates group_name', async () => {
    const res = await request(app).post('/api/groups').send({ description: 'No name' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('group_name is required');
  });

  it('POST /api/groups/:id/members/:memberId adds membership', async () => {
    (groupService.getGroupById as jest.Mock).mockResolvedValue({
      group_id: 'group-1',
      group_name: 'Mentors',
      description: null,
      is_system: false,
    });
    (memberService.getMemberById as jest.Mock).mockResolvedValue({
      member_id: 'member-1',
      first_name: 'Alex',
      last_name: 'River',
      email: 'alex@example.com',
    });
    (groupService.addMemberToGroup as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app).post('/api/groups/group-1/members/member-1');

    expect(res.status).toBe(201);
    expect(groupService.addMemberToGroup).toHaveBeenCalledWith('member-1', 'group-1');
  });
});
