import express from 'express';
import request from 'supertest';
import supportRouter from '../routes/support';
import { getPool } from '../db';
import { notificationService } from '../services/notifications';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: (_length?: unknown) => 'NVarChar',
    Bit: 'Bit',
    MAX: 'MAX',
  },
}));

jest.mock('../services/notifications', () => ({
  notificationService: {
    sendEmail: jest.fn(),
  },
}));

jest.mock('../middleware/rateLimiter', () => ({
  apiLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  writeLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

jest.mock('../middleware/auth', () => ({
  __esModule: true,
  default: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { email: 'admin@example.com', roles: ['ADMIN'], sub: 'sub-admin' } as express.Request['user'];
    next();
  },
}));

jest.mock('../middleware/rbac', () => ({
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

type QueryResult = { recordset?: unknown[]; rowsAffected?: number[] };

describe('support routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/support', supportRouter);

  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function mockPoolWithResults(results: QueryResult[]): void {
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => results.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });
  }

  it('GET /api/support/relay-config returns defaults when config row missing', async () => {
    mockPoolWithResults([{ recordset: [] }]);

    const res = await request(app).get('/api/support/relay-config');

    expect(res.status).toBe(200);
    expect(res.body.supportInboxEmail).toBe('support@phwcoloradoalpine.org');
    expect(Array.isArray(res.body.relayRecipients)).toBe(true);
    expect(res.body.enabled).toBe(false);
  });

  it('PUT /api/support/relay-config updates and returns persisted config', async () => {
    mockPoolWithResults([
      { rowsAffected: [1] },
      {
        recordset: [
          {
            support_inbox_email: 'support@phwcoloradoalpine.org',
            relay_to_csv: 'ops1@example.com,ops2@example.com',
            is_enabled: true,
            updated_at: new Date('2026-04-07T21:00:00.000Z'),
            updated_by: 'admin@example.com',
          },
        ],
      },
    ]);

    const res = await request(app)
      .put('/api/support/relay-config')
      .send({
        support_inbox_email: 'support@phwcoloradoalpine.org',
        relay_to: ['ops1@example.com', 'ops2@example.com'],
        enabled: true,
      });

    expect(res.status).toBe(200);
    expect(res.body.relayRecipients).toEqual(['ops1@example.com', 'ops2@example.com']);
    expect(res.body.enabled).toBe(true);
  });

  it('POST /api/support/inbound relays support email to configured recipients', async () => {
    process.env.SUPPORT_INBOUND_WEBHOOK_TOKEN = 'test-token';

    mockPoolWithResults([
      {
        recordset: [
          {
            support_inbox_email: 'support@phwcoloradoalpine.org',
            relay_to_csv: 'ops1@example.com,ops2@example.com',
            is_enabled: true,
            updated_at: new Date('2026-04-07T21:00:00.000Z'),
            updated_by: 'admin@example.com',
          },
        ],
      },
      { rowsAffected: [1] },
    ]);

    (notificationService.sendEmail as jest.Mock).mockResolvedValue(undefined);

    const res = await request(app)
      .post('/api/support/inbound')
      .set('x-support-inbound-token', 'test-token')
      .send({
        from: 'member@example.com',
        to: 'Support@PHWColoradoAlpine.org',
        subject: 'Help with RSVP',
        text: 'I cannot RSVP from the link.',
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('relayed');
    expect(notificationService.sendEmail).toHaveBeenCalledTimes(2);
    expect(notificationService.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ops1@example.com', operationType: 'support_inbound_relay' })
    );
    expect(notificationService.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ops2@example.com', operationType: 'support_inbound_relay' })
    );
  });

  it('POST /api/support/inbound rejects invalid webhook token', async () => {
    process.env.SUPPORT_INBOUND_WEBHOOK_TOKEN = 'test-token';

    mockPoolWithResults([{ rowsAffected: [1] }]);

    const res = await request(app)
      .post('/api/support/inbound')
      .set('x-support-inbound-token', 'wrong-token')
      .send({
        from: 'member@example.com',
        to: 'support@phwcoloradoalpine.org',
        subject: 'Help',
        text: 'Need assistance',
      });

    expect(res.status).toBe(401);
    expect(notificationService.sendEmail).not.toHaveBeenCalled();
  });
});
