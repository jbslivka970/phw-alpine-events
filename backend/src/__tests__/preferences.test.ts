import express from 'express';
import request from 'supertest';
import preferencesRouter from '../routes/preferences';
import { getPool } from '../db';
import { createEmailUnsubscribeToken } from '../services/emailPreferenceLinkService';
import { notificationService } from '../services/notifications';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: 'NVarChar',
    Int: 'Int',
    DateTime: 'DateTime',
    UniqueIdentifier: 'UniqueIdentifier',
  },
}));

jest.mock('../services/notifications', () => ({
  notificationService: {
    writeEmailPreferenceLog: jest.fn(),
  },
}));

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

describe('preferences routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/preferences', preferencesRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/preferences/email/unsubscribe/:token opts the member out and returns HTML', async () => {
    const token = createEmailUnsubscribeToken('00000000-0000-0000-0000-000000000010', 'member@example.com');
    const queue = [
      { recordset: [{ member_id: '00000000-0000-0000-0000-000000000010', email: 'member@example.com', email_opt_out: false }] },
      { rowsAffected: [1] },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queue.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).get(`/api/preferences/email/unsubscribe/${token}`);

    expect(res.status).toBe(200);
    expect(res.type).toContain('text/html');
    expect(res.text).toContain('You have been unsubscribed from PHW Alpine email notifications.');
    expect(notificationService.writeEmailPreferenceLog).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: '00000000-0000-0000-0000-000000000010',
        outcome: 'unsubscribed',
      })
    );
  });

  it('GET /api/preferences/email/unsubscribe/:token returns already unsubscribed when opt-out already set', async () => {
    const token = createEmailUnsubscribeToken('00000000-0000-0000-0000-000000000011', 'member2@example.com');
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({
        recordset: [{ member_id: '00000000-0000-0000-0000-000000000011', email: 'member2@example.com', email_opt_out: true }],
      }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).get(`/api/preferences/email/unsubscribe/${token}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('already unsubscribed');
    expect(notificationService.writeEmailPreferenceLog).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: '00000000-0000-0000-0000-000000000011',
        outcome: 'already_unsubscribed',
      })
    );
  });

  it('GET /api/preferences/email/unsubscribe/:token rejects invalid tokens', async () => {
    const res = await request(app).get('/api/preferences/email/unsubscribe/not-a-valid-token');

    expect(res.status).toBe(400);
    expect(res.text).toContain('invalid or expired');
    expect(notificationService.writeEmailPreferenceLog).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'invalid_token',
      })
    );
  });

  it('GET /api/preferences/email/logs requires ADMIN role', async () => {
    const res = await request(app)
      .get('/api/preferences/email/logs')
      .set('x-test-roles', 'USER');

    expect(res.status).toBe(403);
  });
});
