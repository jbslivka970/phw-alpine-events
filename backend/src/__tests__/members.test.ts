import express from 'express';
import request from 'supertest';
import membersRouter from '../routes/members';
import * as memberService from '../services/memberService';
import * as groupService from '../services/groupService';
import { getPool } from '../db';
import { notificationService } from '../services/notifications';
import { apiLimiter } from '../middleware/rateLimiter';

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
    const headerEmail = (req.headers['x-test-email'] as string | undefined) ?? 'admin@example.com';
    req.user = {
      sub: headerSub,
      email: headerEmail,
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
  app.use(apiLimiter);
  app.use(express.json());
  app.use('/api/members', membersRouter);
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      SMS_CONSENT_ROLLOUT_EMAIL_ALLOWLIST: 'admin@example.com,member@example.com',
      SMS_CONSENT_ROLLOUT_GROUP_ALLOWLIST: '',
    };
    (groupService.getMemberGroups as jest.Mock).mockResolvedValue([]);
  });

  afterAll(() => {
    process.env = originalEnv;
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
    const mockRequest = createRequest(async () => ({
      recordset: [{ member_id: 'member-2', email: 'different@example.com' }],
    }));
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .patch('/api/members/member-2/sms-consent')
      .set('x-test-roles', 'USER')
      .set('x-test-sub', 'member-1')
      .set('x-test-email', 'member@example.com')
      .send({ sms_opt_in: true });

    expect(res.status).toBe(403);
  });

  it('PATCH /api/members/:id/sms-consent updates consent and writes log', async () => {
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest
        .fn()
        .mockResolvedValueOnce({ recordset: [{ member_id: 'member-1', email: 'admin@example.com' }] })
        .mockResolvedValueOnce({ recordset: [{ member_id: 'member-1', mobile_phone: '+13035551212', sms_opt_in: true }] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .patch('/api/members/member-1/sms-consent')
      .send({ sms_opt_in: true });

    expect(res.status).toBe(200);
    expect(notificationService.writeSmsConsentLog).toHaveBeenCalledWith('member-1', 'opt_in', 'manual');
    expect(notificationService.sendSms).toHaveBeenCalled();
  });

  it('PATCH /api/members/:id/channel-preference updates both sms and email flags', async () => {
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest
        .fn()
        .mockResolvedValueOnce({
          recordset: [{ member_id: 'member-1', email: 'admin@example.com', mobile_phone: '+13035551212', sms_opt_in: false }],
        })
        .mockResolvedValueOnce({
          recordset: [{ member_id: 'member-1', mobile_phone: '+13035551212', sms_opt_in: true, email_opt_out: false }],
        }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .patch('/api/members/member-1/channel-preference')
      .send({ channel_preference: 'both' });

    expect(res.status).toBe(200);
    expect(notificationService.writeSmsConsentLog).toHaveBeenCalledWith(
      'member-1',
      'opt_in',
      'manual',
      'Updated from channel preference'
    );
    expect(notificationService.sendSms).toHaveBeenCalled();
  });

  it('PATCH /api/members/:id/sms-consent allows same-email self-service even when sub differs', async () => {
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest
        .fn()
        .mockResolvedValueOnce({ recordset: [{ member_id: 'member-2', email: 'member@example.com' }] })
        .mockResolvedValueOnce({ recordset: [{ member_id: 'member-2', mobile_phone: '+13035550111', sms_opt_in: true }] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .patch('/api/members/member-2/sms-consent')
      .set('x-test-roles', 'USER')
      .set('x-test-sub', 'auth-subject-that-is-not-member-id')
      .set('x-test-email', 'member@example.com')
      .send({ sms_opt_in: true });

    expect(res.status).toBe(200);
  });

  it('PATCH /api/members/:id/sms-consent blocks opt-in when member is outside rollout cohort', async () => {
    process.env.SMS_CONSENT_ROLLOUT_EMAIL_ALLOWLIST = 'someone-else@example.com';
    process.env.SMS_CONSENT_ROLLOUT_GROUP_ALLOWLIST = '';

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest
        .fn()
        .mockResolvedValueOnce({ recordset: [{ member_id: 'member-2', email: 'member@example.com' }] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .patch('/api/members/member-2/sms-consent')
      .set('x-test-roles', 'USER')
      .set('x-test-sub', 'auth-subject-that-is-not-member-id')
      .set('x-test-email', 'member@example.com')
      .send({ sms_opt_in: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('SMS enrollment is not enabled for this account yet.');
  });

  it('PATCH /api/members/:id/sms-consent allows opt-in when rollout group matches', async () => {
    process.env.SMS_CONSENT_ROLLOUT_EMAIL_ALLOWLIST = '';
    process.env.SMS_CONSENT_ROLLOUT_GROUP_ALLOWLIST = 'Mentors';
    (groupService.getMemberGroups as jest.Mock).mockResolvedValue([
      {
        group_id: 'group-1',
        group_name: 'Mentors',
        description: null,
        is_system: false,
        created_at: new Date(),
      },
    ]);

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest
        .fn()
        .mockResolvedValueOnce({ recordset: [{ member_id: 'member-2', email: 'member@example.com' }] })
        .mockResolvedValueOnce({ recordset: [{ member_id: 'member-2', mobile_phone: '+13035550111', sms_opt_in: true }] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .patch('/api/members/member-2/sms-consent')
      .set('x-test-roles', 'USER')
      .set('x-test-sub', 'auth-subject-that-is-not-member-id')
      .set('x-test-email', 'member@example.com')
      .send({ sms_opt_in: true });

    expect(res.status).toBe(200);
  });

  it('GET /api/members/:id/rsvps allows same-email self-service when sub differs', async () => {
    const queue = [
      { recordset: [{ member_id: 'member-2', email: 'member@example.com' }] },
      {
        recordset: [
          {
            response_id: 'response-1',
            response: 'yes',
            responded_at: new Date('2026-04-01T10:00:00.000Z'),
            event_id: 'event-1',
            title: 'Spring Event',
            event_date: new Date('2026-04-05T18:00:00.000Z'),
            location: 'Denver',
            status: 'published',
          },
        ],
      },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queue.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .get('/api/members/member-2/rsvps')
      .set('x-test-roles', 'USER')
      .set('x-test-sub', 'auth-subject-not-member-id')
      .set('x-test-email', 'member@example.com');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it('GET /api/members/:id/rsvps blocks non-admin non-self access', async () => {
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest
        .fn()
        .mockResolvedValueOnce({ recordset: [{ member_id: 'member-2', email: 'different@example.com' }] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .get('/api/members/member-2/rsvps')
      .set('x-test-roles', 'USER')
      .set('x-test-sub', 'member-1')
      .set('x-test-email', 'member@example.com');

    expect(res.status).toBe(403);
  });

  it('GET /api/members/:id/participation allows same-email self-service when sub differs', async () => {
    const queue = [
      { recordset: [{ member_id: 'member-2', email: 'member@example.com' }] },
      {
        recordset: [
          {
            events_attended: 2,
            events_attended_prior_year: 1,
            mentor_attended: 1,
            mentor_attended_prior_year: 0,
            participant_attended: 1,
            participant_attended_prior_year: 1,
          },
        ],
      },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queue.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .get('/api/members/member-2/participation')
      .set('x-test-roles', 'USER')
      .set('x-test-sub', 'auth-subject-not-member-id')
      .set('x-test-email', 'member@example.com');

    expect(res.status).toBe(200);
    expect(res.body.member_id).toBe('member-2');
    expect(res.body.events_attended).toBe(2);
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
