import express from 'express';
import request from 'supertest';
import preferencesRouter from '../routes/preferences';
import { getPool } from '../db';
import { createEmailUnsubscribeToken } from '../services/emailPreferenceLinkService';
import { notificationService } from '../services/notifications';
import { apiLimiter } from '../middleware/rateLimiter';

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
    const tenantId = (req.headers['x-test-tenant-id'] as string | undefined) ?? '00000000-0000-4000-8000-000000000010';
    req.user = {
      sub: '00000000-0000-0000-0000-000000000001',
      email: 'admin@example.com',
      roles: headerRoles.split(',') as ('ADMIN' | 'EVENT_CREATOR' | 'USER')[],
      rawClaims: {},
    };
    req.tenantId = tenantId;
    next();
  },
}));

jest.mock('../middleware/rateLimiter', () => ({
  apiLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  writeLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

describe('preferences routes', () => {
  const app = express();
  app.use(apiLimiter);
  app.use(express.json());
  app.use('/api/preferences', preferencesRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/preferences/email/unsubscribe/:token opts the member out and returns HTML', async () => {
    const token = createEmailUnsubscribeToken('00000000-0000-0000-0000-000000000010', 'member@example.com');
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async (sqlText: string) => {
        if (sqlText.includes('COL_LENGTH(\'dbo.email_preference_log\'')) {
          return { recordset: [{ has_log_tenant_id: 1, has_member_tenant_id: 1 }] };
        }

        if (sqlText.includes('SELECT member_id, email')) {
          return { recordset: [{ member_id: '00000000-0000-0000-0000-000000000010', email: 'member@example.com', email_opt_out: false }] };
        }

        if (sqlText.includes('UPDATE member')) {
          return { rowsAffected: [1] };
        }

        return { recordset: [] };
      }),
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
      query: jest.fn().mockImplementation(async (sqlText: string) => {
        if (sqlText.includes('SELECT member_id, email')) {
          return {
            recordset: [{ member_id: '00000000-0000-0000-0000-000000000011', email: 'member2@example.com', email_opt_out: true }],
          };
        }

        return { recordset: [] };
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

  it('GET /api/preferences/email/unsubscribe/:token enforces token tenant when member tenant support exists', async () => {
    const tokenTenantId = '00000000-0000-4000-8000-0000000000cc';
    const token = createEmailUnsubscribeToken(
      '00000000-0000-0000-0000-000000000012',
      'member3@example.com',
      tokenTenantId,
    );

    const querySpy = jest.fn().mockImplementation(async (sqlText: string) => {
      if (sqlText.includes('COL_LENGTH(\'dbo.email_preference_log\'')) {
        return {
          recordset: [{ has_log_tenant_id: 1, has_member_tenant_id: 1 }],
        };
      }

      if (sqlText.includes('SELECT member_id, email')) {
        return {
          recordset: [{
            member_id: '00000000-0000-0000-0000-000000000012',
            email: 'member3@example.com',
            email_opt_out: false,
            tenant_id: tokenTenantId,
          }],
        };
      }

      if (sqlText.includes('UPDATE member')) {
        return { rowsAffected: [1] };
      }

      return { recordset: [] };
    });

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: querySpy,
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).get(`/api/preferences/email/unsubscribe/${token}`);

    expect(res.status).toBe(200);
    expect(String(querySpy.mock.calls.find((call) => String(call[0]).includes('SELECT member_id, email'))?.[0] ?? '')).toContain('AND tenant_id = @tenant_id');
    expect(mockRequest.input).toHaveBeenCalledWith('tenant_id', 'UniqueIdentifier', tokenTenantId);
    expect(notificationService.writeEmailPreferenceLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: tokenTenantId,
        outcome: 'unsubscribed',
      })
    );
  });

  it('GET /api/preferences/email/logs applies tenant scope when multi-tenant support is available', async () => {
    const previous = process.env.MULTI_TENANT_ENABLED;
    process.env.MULTI_TENANT_ENABLED = 'true';

    const tenantInput = '00000000-0000-4000-8000-0000000000bb';
    const querySpy = jest.fn().mockImplementation(async (sqlText: string) => {
      if (sqlText.includes('COL_LENGTH(\'dbo.email_preference_log\'')) {
        return {
          recordset: [{ has_log_tenant_id: 1, has_member_tenant_id: 1 }],
        };
      }

      return { recordset: [] };
    });

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: querySpy,
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .get('/api/preferences/email/logs')
      .set('x-test-tenant-id', tenantInput);

    expect(res.status).toBe(200);
    expect(String(querySpy.mock.calls.find((call) => String(call[0]).includes('FROM email_preference_log'))?.[0] ?? '')).toContain('AND tenant_id = @tenant_id');
    expect(mockRequest.input).toHaveBeenCalledWith('tenant_id', 'UniqueIdentifier', tenantInput);

    process.env.MULTI_TENANT_ENABLED = previous;
  });
});
