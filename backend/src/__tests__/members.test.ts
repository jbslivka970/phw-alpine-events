import express from 'express';
import request from 'supertest';
import membersRouter from '../routes/members';
import * as memberService from '../services/memberService';
import { getPool } from '../db';
import { notificationService } from '../services/notifications';

jest.mock('../services/memberService');

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: 'NVarChar',
    Int: 'Int',
    DateTime: 'DateTime',
    Bit: 'Bit',
    UniqueIdentifier: 'UniqueIdentifier',
  },
}));

jest.mock('../services/notifications', () => ({
  notificationService: {
    writeSmsConsentLog: jest.fn(),
    sendSms: jest.fn(),
  },
}));

jest.mock('../services/groupService', () => ({
  getMemberGroups: jest.fn().mockResolvedValue([]),
}));

jest.mock('../middleware/auth', () => ({
  __esModule: true,
  default: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    const headerRoles = (req.headers['x-test-roles'] as string | undefined) ?? 'ADMIN';
    const headerSub = (req.headers['x-test-sub'] as string | undefined) ?? '00000000-0000-0000-0000-000000000001';
    req.user = {
      sub: headerSub,
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

interface MockRequest {
  input: jest.Mock;
  query: jest.Mock;
}

function createRequest(handler: () => Promise<unknown>): MockRequest {
  const req = {
    input: jest.fn().mockReturnThis(),
    query: jest.fn().mockImplementation(handler),
  };
  return req;
}

describe('members routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/members', membersRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/members returns paged members', async () => {
    (memberService.listMembers as jest.Mock).mockResolvedValue({ data: [], total: 0 });

    const res = await request(app).get('/api/members?page=2&pageSize=10');

    expect(res.status).toBe(200);
    expect(memberService.listMembers).toHaveBeenCalledWith({
      page: 2,
      pageSize: 10,
      search: undefined,
      isActive: undefined,
    });
  });

  it('PATCH /api/members/:id/sms-consent blocks non-admin editing other users', async () => {
    const res = await request(app)
      .patch('/api/members/member-2/sms-consent')
      .set('x-test-roles', 'USER')
      .set('x-test-sub', 'member-1')
      .send({ sms_opt_in: true });

    expect(res.status).toBe(403);
  });

  it('PATCH /api/members/:id/sms-consent updates consent and writes log', async () => {
    const mockRequest = createRequest(async () => ({
      recordset: [{ member_id: 'member-1', mobile_phone: '+13035551212', sms_opt_in: true }],
    }));
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .patch('/api/members/member-1/sms-consent')
      .send({ sms_opt_in: true });

    expect(res.status).toBe(200);
    expect(notificationService.writeSmsConsentLog).toHaveBeenCalledWith('member-1', 'opt_in', 'manual');
    expect(notificationService.sendSms).toHaveBeenCalled();
  });

  it('POST /api/members maps duplicate member error to 409', async () => {
    const conflictError = Object.assign(new Error('duplicate'), { statusCode: 409 });
    (memberService.createMember as jest.Mock).mockRejectedValue(conflictError);

    const res = await request(app)
      .post('/api/members')
      .send({ first_name: 'Pat', last_name: 'Stone', email: 'pat@example.com' });

    expect(res.status).toBe(409);
  });
});
