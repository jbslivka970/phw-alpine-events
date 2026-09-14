import express from 'express';
import request from 'supertest';
import smsRouter from '../routes/sms';
import { getPool } from '../db';
import { apiLimiter } from '../middleware/rateLimiter';
import { generateKeyPairSync, sign } from 'node:crypto';
import { notificationService } from '../services/notifications';

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
  publicLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
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
  app.use(express.json({
    verify: (req, _res, buffer) => {
      (req as express.Request).rawBody = Buffer.from(buffer);
    },
  }));
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

  it('rejects unsigned Telnyx inbound messages in production', async () => {
    process.env.NODE_ENV = 'production';
    const res = await request(app)
      .post('/api/sms/inbound')
      .send({ data: { payload: { from: { phone_number: '+13035550111' }, text: 'STOP' } } });

    expect(res.status).toBe(401);
    expect(getPool).not.toHaveBeenCalled();
  });

  it('accepts a valid current Telnyx signature before processing', async () => {
    process.env.NODE_ENV = 'production';
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicDer = publicKey.export({ format: 'der', type: 'spki' });
    process.env.TELNYX_WEBHOOK_PUBLIC_KEY = publicDer.subarray(-32).toString('base64');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = {
      data: {
        id: 'evt-valid-1',
        payload: {
          from: { phone_number: '+13035550111' },
          to: [{ phone_number: '+13035550999' }],
          text: 'HELP',
        },
      },
    };
    const rawBody = JSON.stringify(body);
    const signature = sign(null, Buffer.from(`${timestamp}|${rawBody}`), privateKey).toString('base64');
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async (queryText: string) => {
        if (queryText.includes('FROM dbo.tenant_messaging')) {
          return {
            recordset: [{
              tenant_id: '11111111-1111-4111-8111-111111111111',
              telnyx_from_number: '+13035550999',
              sms_from: null,
            }],
          };
        }
        return { recordset: [] };
      }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .post('/api/sms/inbound')
      .set('Content-Type', 'application/json')
      .set('telnyx-timestamp', timestamp)
      .set('telnyx-signature-ed25519', signature)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ignored');
  });

  it('rejects forged and stale Telnyx signatures before database access', async () => {
    process.env.NODE_ENV = 'production';
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicDer = publicKey.export({ format: 'der', type: 'spki' });
    process.env.TELNYX_WEBHOOK_PUBLIC_KEY = publicDer.subarray(-32).toString('base64');
    const body = {
      data: {
        id: 'evt-rejected',
        payload: {
          from: { phone_number: '+13035550111' },
          to: { phone_number: '+13035550999' },
          text: 'STOP',
        },
      },
    };

    const currentTimestamp = String(Math.floor(Date.now() / 1000));
    const forged = await request(app)
      .post('/api/sms/inbound')
      .set('telnyx-timestamp', currentTimestamp)
      .set('telnyx-signature-ed25519', Buffer.alloc(64).toString('base64'))
      .send(body);

    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);
    const staleRawBody = JSON.stringify(body);
    const staleSignature = sign(null, Buffer.from(`${staleTimestamp}|${staleRawBody}`), privateKey).toString('base64');
    const stale = await request(app)
      .post('/api/sms/inbound')
      .set('telnyx-timestamp', staleTimestamp)
      .set('telnyx-signature-ed25519', staleSignature)
      .send(body);

    expect(forged.status).toBe(401);
    expect(stale.status).toBe(401);
    expect(getPool).not.toHaveBeenCalled();
  });

  it('returns idempotent success for a replayed valid Telnyx event before mutation', async () => {
    process.env.NODE_ENV = 'production';
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicDer = publicKey.export({ format: 'der', type: 'spki' });
    process.env.TELNYX_WEBHOOK_PUBLIC_KEY = publicDer.subarray(-32).toString('base64');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = {
      data: {
        id: 'evt-replay-1',
        payload: {
          from: { phone_number: '+13035550111' },
          to: { phone_number: '+13035550999' },
          text: 'STOP',
        },
      },
    };
    const signature = sign(null, Buffer.from(`${timestamp}|${JSON.stringify(body)}`), privateKey).toString('base64');
    const queries: string[] = [];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async (queryText: string) => {
        queries.push(queryText);
        if (queryText.includes('FROM dbo.tenant_messaging')) {
          return {
            recordset: [{
              tenant_id: '11111111-1111-4111-8111-111111111111',
              telnyx_from_number: '+13035550999',
              sms_from: null,
            }],
          };
        }
        if (queryText.includes('INSERT INTO dbo.webhook_receipt')) {
          throw { number: 2627 };
        }
        return { recordset: [] };
      }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .post('/api/sms/inbound')
      .set('telnyx-timestamp', timestamp)
      .set('telnyx-signature-ed25519', signature)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'duplicate', provider_event_id: 'evt-replay-1' });
    expect(queries.some((queryText) => queryText.includes('FROM member m'))).toBe(false);
    expect(notificationService.sendSms).not.toHaveBeenCalled();
  });

  it('fails closed when a signed destination maps to multiple active tenants', async () => {
    process.env.NODE_ENV = 'production';
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicDer = publicKey.export({ format: 'der', type: 'spki' });
    process.env.TELNYX_WEBHOOK_PUBLIC_KEY = publicDer.subarray(-32).toString('base64');
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = {
      data: {
        id: 'evt-ambiguous-1',
        payload: {
          from: { phone_number: '+13035550111' },
          to: { phone_number: '+1 (303) 555-0999' },
          text: 'HELP',
        },
      },
    };
    const signature = sign(null, Buffer.from(`${timestamp}|${JSON.stringify(body)}`), privateKey).toString('base64');
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({
        recordset: [
          { tenant_id: '11111111-1111-4111-8111-111111111111', telnyx_from_number: '+13035550999', sms_from: null },
          { tenant_id: '22222222-2222-4222-8222-222222222222', telnyx_from_number: null, sms_from: '303-555-0999' },
        ],
      }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .post('/api/sms/inbound')
      .set('telnyx-timestamp', timestamp)
      .set('telnyx-signature-ed25519', signature)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('exactly one active tenant');
    expect(notificationService.sendSms).not.toHaveBeenCalled();
  });
});