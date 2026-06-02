import express from 'express';
import request from 'supertest';
import smsRouter from '../routes/sms';
import { getPool } from '../db';
import { apiLimiter } from '../middleware/rateLimiter';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    Int: 'Int',
    NVarChar: 'NVarChar',
    UniqueIdentifier: 'UniqueIdentifier',
  },
}));

jest.mock('../services/notifications', () => ({
  notificationService: {
    sendSms: jest.fn(),
    writeSmsConsentLog: jest.fn(),
  },
}));

jest.mock('../services/rsvpService', () => ({
  inferResponseRoleForMember: jest.fn(),
  VALID_RESPONSES: ['yes', 'no', 'maybe', 'waitlist'],
  listPendingEventsForMember: jest.fn(),
  recordRsvpResponse: jest.fn(),
  RsvpError: class RsvpError extends Error {},
}));

jest.mock('../services/rsvpLinkService', () => ({
  verifyRsvpToken: jest.fn(),
}));

jest.mock('../middleware/rateLimiter', () => ({
  apiLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  writeLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
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

describe('sms routes', () => {
  const app = express();
  app.use(apiLimiter);
  app.use(express.json());
  app.use('/api/sms', smsRouter);

  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, MULTI_TENANT_ENABLED: 'true' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('GET /api/sms/inbound/logs applies tenant filtering when tenant support exists', async () => {
    const queries: string[] = [];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async (queryText: string) => {
        queries.push(queryText);
        if (queryText.includes('has_member_tenant_table')) {
          return { recordset: [{ has_member_tenant_table: 1, has_event_tenant_column: 1 }] };
        }
        return {
          recordset: [
            {
              inbound_log_id: '44444444-4444-4444-8444-444444444444',
              source: 'direct',
              from_phone: '+13035550111',
              normalized_phone: '+13035550111',
              member_id: '55555555-5555-4555-8555-555555555555',
              event_id: '66666666-6666-4666-8666-666666666666',
              inbound_message: 'Y',
              parsed_response: 'yes',
              processing_status: 'recorded',
              response_message: null,
              error_detail: null,
              received_at: new Date('2026-06-02T01:00:00.000Z'),
            },
          ],
        };
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).get('/api/sms/inbound/logs');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(mockRequest.input).toHaveBeenCalledWith('tenant_id', 'UniqueIdentifier', '11111111-1111-4111-8111-111111111111');
    const logsQuery = queries.find((queryText) => queryText.includes('FROM dbo.inbound_sms_log log'));
    expect(logsQuery).toContain('FROM dbo.member_tenant mt');
    expect(logsQuery).toContain('FROM dbo.event e');
    expect(logsQuery).toContain('mt.tenant_id = @tenant_id');
    expect(logsQuery).toContain('e.tenant_id = @tenant_id');
  });
});