import express from 'express';
import request from 'supertest';
import templatesRouter from '../routes/templates';
import { getPool } from '../db';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: jest.fn(() => 'NVarChar'),
    UniqueIdentifier: 'UniqueIdentifier',
    Bit: 'Bit',
    MAX: 'MAX',
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

describe('templates routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/templates', templatesRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/templates returns templates list', async () => {
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({
        recordset: [
          {
            template_id: '00000000-0000-4000-8000-000000000001',
            template_name: 'Event Invite',
            channel: 'email',
            subject: 'Invitation',
            body: '<p>Hello</p>',
            is_active: true,
            created_at: new Date('2026-03-01T00:00:00.000Z'),
            updated_at: new Date('2026-03-02T00:00:00.000Z'),
          },
        ],
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).get('/api/templates');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].template_name).toBe('Event Invite');
  });

  it('POST /api/templates validates required subject for email templates', async () => {
    const res = await request(app)
      .post('/api/templates')
      .send({ template_name: 'Event Invite', channel: 'email', body: 'Body without subject' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('subject is required');
  });

  it('POST /api/templates creates a template', async () => {
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({
        recordset: [
          {
            template_id: '00000000-0000-4000-8000-000000000002',
            template_name: 'Reminder SMS',
            channel: 'sms',
            subject: null,
            body: 'Reminder body',
            is_active: true,
            created_at: new Date('2026-03-03T00:00:00.000Z'),
            updated_at: new Date('2026-03-03T00:00:00.000Z'),
          },
        ],
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .post('/api/templates')
      .send({ template_name: 'Reminder SMS', channel: 'sms', body: 'Reminder body' });

    expect(res.status).toBe(201);
    expect(res.body.template_name).toBe('Reminder SMS');
    expect(res.body.channel).toBe('sms');
  });

  it('PATCH /api/templates/:id returns 404 when template is missing', async () => {
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest
        .fn()
        .mockResolvedValueOnce({ recordset: [] }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .patch('/api/templates/00000000-0000-4000-8000-000000000099')
      .send({ template_name: 'Missing' });

    expect(res.status).toBe(404);
  });

  it('DELETE /api/templates/:id deactivates template', async () => {
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({
        recordset: [
          {
            template_id: '00000000-0000-4000-8000-000000000003',
            template_name: 'Old Template',
            channel: 'email',
            subject: 'Old',
            body: 'Body',
            is_active: false,
            created_at: new Date('2026-03-01T00:00:00.000Z'),
            updated_at: new Date('2026-03-05T00:00:00.000Z'),
          },
        ],
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).delete('/api/templates/00000000-0000-4000-8000-000000000003');

    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(false);
  });

  it('GET /api/templates/:id/history returns template versions', async () => {
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({
        recordset: [
          {
            version_id: '00000000-0000-4000-8000-000000000101',
            template_id: '00000000-0000-4000-8000-000000000001',
            template_name: 'Event Invite',
            channel: 'email',
            subject: 'Invitation',
            body: '<p>Hello</p>',
            is_active: true,
            action: 'update',
            reason: 'copy refresh',
            changed_by: 'admin@example.com',
            created_at: new Date('2026-03-07T00:00:00.000Z'),
          },
        ],
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).get('/api/templates/00000000-0000-4000-8000-000000000001/history');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].action).toBe('update');
  });

  it('POST /api/templates/:id/rollback requires approval', async () => {
    const res = await request(app)
      .post('/api/templates/00000000-0000-4000-8000-000000000001/rollback')
      .send({ version_id: '00000000-0000-4000-8000-000000000101', approved: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('approved must be true');
  });

  it('POST /api/templates/:id/rollback applies selected version', async () => {
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async (sqlText: string) => {
        if (sqlText.includes('FROM notification_template_version') && sqlText.includes('version_id')) {
          return {
            recordset: [
              {
                version_id: '00000000-0000-4000-8000-000000000101',
                template_id: '00000000-0000-4000-8000-000000000001',
                template_name: 'Event Invite',
                channel: 'email',
                subject: 'Restored Subject',
                body: '<p>Restored</p>',
                is_active: true,
                action: 'update',
                reason: 'old copy',
                changed_by: 'admin@example.com',
                created_at: new Date('2026-03-07T00:00:00.000Z'),
              },
            ],
          };
        }

        if (sqlText.includes('FROM notification_template') && sqlText.includes('WHERE template_id')) {
          return {
            recordset: [
              {
                template_id: '00000000-0000-4000-8000-000000000001',
                template_name: 'Event Invite',
                channel: 'email',
                subject: 'Current Subject',
                body: '<p>Current</p>',
                is_active: true,
                created_at: new Date('2026-03-01T00:00:00.000Z'),
                updated_at: new Date('2026-03-08T00:00:00.000Z'),
              },
            ],
          };
        }

        if (sqlText.includes('UPDATE notification_template')) {
          return {
            recordset: [
              {
                template_id: '00000000-0000-4000-8000-000000000001',
                template_name: 'Event Invite',
                channel: 'email',
                subject: 'Restored Subject',
                body: '<p>Restored</p>',
                is_active: true,
                created_at: new Date('2026-03-01T00:00:00.000Z'),
                updated_at: new Date('2026-03-09T00:00:00.000Z'),
              },
            ],
          };
        }

        return { recordset: [] };
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .post('/api/templates/00000000-0000-4000-8000-000000000001/rollback')
      .send({
        version_id: '00000000-0000-4000-8000-000000000101',
        approved: true,
        reason: 'Rollback for bad copy',
      });

    expect(res.status).toBe(200);
    expect(res.body.subject).toBe('Restored Subject');
    expect(res.body.rolled_back_to_version_id).toBe('00000000-0000-4000-8000-000000000101');
  });
});
