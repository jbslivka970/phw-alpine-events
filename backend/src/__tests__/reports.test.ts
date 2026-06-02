import express from 'express';
import request from 'supertest';
import reportsRouter from '../routes/reports';
import { getPool } from '../db';
import { apiLimiter } from '../middleware/rateLimiter';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    DateTime: 'DateTime',
    NVarChar: (_length?: unknown) => 'NVarChar',
    UniqueIdentifier: 'UniqueIdentifier',
    Int: 'Int',
  },
}));

jest.mock('../services/notifications', () => ({
  getAcsEmailProviderDeliveryStatus: jest.fn(),
}));

jest.mock('../middleware/rateLimiter', () => ({
  apiLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

jest.mock('../middleware/auth', () => ({
  __esModule: true,
  default: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = { email: 'admin@example.com', roles: ['ADMIN'], sub: 'sub-admin' } as express.Request['user'];
    req.tenantId = '11111111-1111-4111-8111-111111111111';
    next();
  },
}));

jest.mock('../middleware/rbac', () => ({
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

type QueryResult = { recordset?: unknown[]; rowsAffected?: number[] };

describe('reports routes', () => {
  const app = express();
  app.use(apiLimiter);
  app.use(express.json());
  app.use('/api/reports', reportsRouter);

  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, MULTI_TENANT_ENABLED: 'true' };
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

  it('GET /api/reports/delivery/logs denies cross-tenant event filters', async () => {
    mockPoolWithResults([
      { recordset: [{ has_tenant_id: 1 }] },
      { recordset: [] },
    ]);

    const res = await request(app)
      .get('/api/reports/delivery/logs')
      .query({ event_id: '22222222-2222-4222-8222-222222222222' });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Event not found' });
  });

  it('GET /api/reports/delivery/event/:eventId/coverage denies cross-tenant event access', async () => {
    mockPoolWithResults([
      { recordset: [] },
    ]);

    const res = await request(app)
      .get('/api/reports/delivery/event/33333333-3333-4333-8333-333333333333/coverage');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Event not found' });
  });

  it('GET /api/reports/delivery/logs returns rows for an in-tenant event filter', async () => {
    mockPoolWithResults([
      { recordset: [{ event_id: '22222222-2222-4222-8222-222222222222' }] },
      {
        recordset: [
          {
            log_id: '44444444-4444-4444-8444-444444444444',
            sent_at: new Date('2026-06-02T01:00:00.000Z'),
            event_id: '22222222-2222-4222-8222-222222222222',
            member_id: null,
            template_id: null,
            channel: 'email',
            recipient: 'member@example.com',
            status: 'sent',
            operation_type: 'event_published',
            operation_reason: null,
            provider_id: null,
            error_detail: null,
          },
        ],
      },
      { recordset: [{ total_rows: 1 }] },
    ]);

    const res = await request(app)
      .get('/api/reports/delivery/logs')
      .query({ event_id: '22222222-2222-4222-8222-222222222222' });

    expect(res.status).toBe(200);
    expect(res.body.total_rows).toBe(1);
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0]).toEqual(expect.objectContaining({
      event_id: '22222222-2222-4222-8222-222222222222',
      recipient: 'member@example.com',
      operation_type: 'event_published',
    }));
  });
});