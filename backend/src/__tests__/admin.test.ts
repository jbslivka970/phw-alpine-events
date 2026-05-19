import express from 'express';
import request from 'supertest';
import adminRouter from '../routes/admin';
import { getPool } from '../db';
import { generateInviteDraft } from '../services/aiInviteService';
import { runRetentionJob } from '../jobs/retentionJob';
import { apiLimiter } from '../middleware/rateLimiter';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: (length?: number) => `NVarChar(${length ?? 'default'})`,
    Int: 'Int',
    DateTime: 'DateTime',
    Bit: 'Bit',
    UniqueIdentifier: 'UniqueIdentifier',
    MAX: 'MAX',
  },
}));

jest.mock('../middleware/auth', () => ({
  __esModule: true,
  default: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      sub: '00000000-0000-0000-0000-000000000001',
      email: 'admin@example.com',
      roles: ['ADMIN'],
      rawClaims: {},
    };
    next();
  },
}));

jest.mock('../middleware/rateLimiter', () => ({
  apiLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  writeLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

jest.mock('../services/aiInviteService', () => ({
  generateInviteDraft: jest.fn(),
}));

jest.mock('../jobs/retentionJob', () => ({
  runRetentionJob: jest.fn(),
}));

interface MockRequest {
  input: jest.Mock;
  query: jest.Mock;
}

function createRequest(handler: (query: string) => Promise<unknown>): MockRequest {
  const req = {
    input: jest.fn().mockReturnThis(),
    query: jest.fn().mockImplementation(handler),
  };
  return req;
}

describe('admin routes', () => {
  const app = express();
  app.use(apiLimiter);
  app.use(express.json());
  app.use('/api/admin', adminRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/admin/users returns paginated users', async () => {
    const listRequest = createRequest(async () => ({ recordset: [{ user_id: 'user-1', email: 'a@example.com' }] }));
    const countRequest = createRequest(async () => ({ recordset: [{ total: 1 }] }));
    const pool = {
      request: jest.fn().mockReturnValueOnce(listRequest).mockReturnValueOnce(countRequest),
    };
    (getPool as jest.Mock).mockResolvedValue(pool);

    const res = await request(app).get('/api/admin/users?page=1&pageSize=25');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data).toHaveLength(1);
  });

  it('POST /api/admin/users validates role', async () => {
    const res = await request(app)
      .post('/api/admin/users')
      .send({ email: 'bad@example.com', role: 'owner' });

    expect(res.status).toBe(400);
  });

  it('POST /api/admin/import returns import snapshot', async () => {
    const lookupRequest = createRequest(async () => ({
      recordset: [{ import_id: 'import-1', file_name: 'members.csv', status: 'completed' }],
    }));
    (getPool as jest.Mock).mockResolvedValue({ request: () => lookupRequest });

    const res = await request(app)
      .post('/api/admin/import')
      .send({ import_id: '00000000-0000-0000-0000-000000000001' });

    expect(res.status).toBe(200);
    expect(res.body.import_id).toBe('import-1');
  });

  it('POST /api/admin/ai/invite-draft returns generated draft', async () => {
    (generateInviteDraft as jest.Mock).mockResolvedValue({
      subject: 'You are invited',
      emailBody: 'Email draft',
      smsBody: 'SMS draft',
      provider: 'fallback',
    });

    const res = await request(app)
      .post('/api/admin/ai/invite-draft')
      .send({
        title: 'Casting Clinic',
        event_date: '2026-06-01T18:00:00.000Z',
        location: 'Boulder Creek',
        description: 'Bring waders',
        tone: 'friendly',
      });

    expect(res.status).toBe(200);
    expect(generateInviteDraft).toHaveBeenCalledTimes(1);
    expect(res.body.subject).toBe('You are invited');
  });

  it('POST /api/admin/ai/invite-draft/apply requires explicit approval', async () => {
    const res = await request(app)
      .post('/api/admin/ai/invite-draft/apply')
      .send({
        title: 'Casting Clinic',
        event_date: '2026-06-01T18:00:00.000Z',
        approved: false,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('approved must be true');
  });

  it('POST /api/admin/ai/invite-draft/apply upserts email and sms templates', async () => {
    (generateInviteDraft as jest.Mock).mockResolvedValue({
      subject: 'You are invited',
      emailBody: 'Email draft',
      smsBody: 'SMS draft',
      provider: 'fallback',
    });

    const requestMock = createRequest(async (query: string) => {
      if (query.includes('SELECT TOP 1 template_id') && query.includes('channel = @channel')) {
        const channel = [...requestMock.input.mock.calls]
          .reverse()
          .find((call) => call[0] === 'channel')?.[2];
        if (channel === 'email') {
          return { recordset: [{ template_id: 'existing-email-template' }] };
        }
        return { recordset: [] };
      }

      if (query.includes('UPDATE notification_template')) {
        return { recordset: [{ template_id: 'existing-email-template', updated_at: new Date('2026-06-01T00:00:00.000Z') }] };
      }

      if (query.includes('INSERT INTO notification_template')) {
        return { recordset: [{ template_id: 'new-sms-template', updated_at: new Date('2026-06-01T00:00:01.000Z') }] };
      }

      return { recordset: [] };
    });

    (getPool as jest.Mock).mockResolvedValue({ request: () => requestMock });

    const res = await request(app)
      .post('/api/admin/ai/invite-draft/apply')
      .send({
        title: 'Casting Clinic',
        event_date: '2026-06-01T18:00:00.000Z',
        tone: 'friendly',
        approved: true,
        template_name: 'Event Invite',
        review_note: 'Reviewed by admin',
      });

    expect(res.status).toBe(200);
    expect(generateInviteDraft).toHaveBeenCalledTimes(1);
    expect(res.body.template_name).toBe('Event Invite');
    expect(res.body.templates.email.template_id).toBe('existing-email-template');
    expect(res.body.templates.sms.template_id).toBe('new-sms-template');
  });

  it('POST /api/admin/retention/preview returns dry-run JSON results', async () => {
    (runRetentionJob as jest.Mock).mockResolvedValue([
      {
        target: 'notification_log',
        retentionDays: 30,
        affectedRows: 12,
        mode: 'dry-run',
      },
    ]);

    const res = await request(app)
      .post('/api/admin/retention/preview')
      .send({
        notification_log_days: 30,
      });

    expect(res.status).toBe(200);
    expect(runRetentionJob).toHaveBeenCalledWith(expect.objectContaining({
      dryRun: true,
      notificationLogDays: 30,
    }));
    expect(res.body.mode).toBe('dry-run');
    expect(res.body.results).toHaveLength(1);
  });

  it('POST /api/admin/retention/preview returns csv when requested', async () => {
    (runRetentionJob as jest.Mock).mockResolvedValue([
      {
        target: 'notification_log',
        retentionDays: 30,
        affectedRows: 5,
        mode: 'dry-run',
      },
    ]);

    const res = await request(app)
      .post('/api/admin/retention/preview')
      .send({
        format: 'csv',
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('target,retention_days,candidate_rows,mode,generated_at,generated_by');
    expect(res.text).toContain('"notification_log"');
  });

  it('GET /api/admin/event-summary-email-config returns the stored email configuration', async () => {
    const lookupRequest = createRequest(async () => ({
      recordset: [
        {
          event_summary_email_config_id: 'config-1',
          program_lead_email: 'program@example.com',
          assistant_program_lead_email_1: 'apl1@example.com',
          assistant_program_lead_email_2: 'apl2@example.com',
          updated_at: new Date('2026-05-01T12:00:00.000Z'),
          updated_by: 'admin@example.com',
        },
      ],
    }));
    (getPool as jest.Mock).mockResolvedValue({ request: () => lookupRequest });

    const res = await request(app).get('/api/admin/event-summary-email-config');

    expect(res.status).toBe(200);
    expect(res.body.programLeadEmail).toBe('program@example.com');
    expect(res.body.assistantProgramLeadEmails).toEqual(['apl1@example.com', 'apl2@example.com']);
  });

  it('PUT /api/admin/event-summary-email-config saves the configured CC recipients', async () => {
    const requestMock = createRequest(async (query: string) => {
      if (query.includes('IF EXISTS (SELECT 1 FROM dbo.event_summary_email_config)')) {
        return { rowsAffected: [1] };
      }

      return {
        recordset: [
          {
            event_summary_email_config_id: 'config-1',
            program_lead_email: 'program@example.com',
            assistant_program_lead_email_1: 'apl1@example.com',
            assistant_program_lead_email_2: null,
            updated_at: new Date('2026-05-01T12:00:00.000Z'),
            updated_by: 'admin@example.com',
          },
        ],
      };
    });
    (getPool as jest.Mock).mockResolvedValue({ request: () => requestMock });

    const res = await request(app)
      .put('/api/admin/event-summary-email-config')
      .send({
        program_lead_email: 'program@example.com',
        assistant_program_lead_email_1: 'apl1@example.com',
        assistant_program_lead_email_2: '',
      });

    expect(res.status).toBe(200);
    expect(res.body.programLeadEmail).toBe('program@example.com');
    expect(res.body.assistantProgramLeadEmails).toEqual(['apl1@example.com']);
  });
});
