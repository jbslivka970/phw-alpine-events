import express from 'express';
import request from 'supertest';
import eventsRouter from '../routes/events';
import { getPool } from '../db';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: 'NVarChar',
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

jest.mock('../services/notifications', () => ({
  sendEventPublishedNotification: jest.fn(),
  sendEventCancelledNotification: jest.fn(),
}));

interface MockRequest {
  input: jest.Mock;
  query: jest.Mock;
}

function createRequest(handler: (query: string, params: Record<string, unknown>) => Promise<unknown>): MockRequest {
  const params: Record<string, unknown> = {};
  const req = {
    input: jest.fn().mockImplementation((name: string, _type: unknown, value: unknown) => {
      params[name] = value;
      return req;
    }),
    query: jest.fn().mockImplementation((query: string) => handler(query, params)),
  };

  return req;
}

describe('events routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/events', eventsRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/events returns events and applies status filter', async () => {
    const mockRequest = createRequest(async () => ({
      recordset: [{ event_id: 'event-1', title: 'Fly Tying 101', status: 'draft' }],
    }));
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).get('/api/events?status=draft');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ event_id: 'event-1', title: 'Fly Tying 101', status: 'draft' }]);
    expect(mockRequest.input).toHaveBeenCalledWith('status', 'NVarChar', 'draft');
  });

  it('PUT /api/events/:id/status rejects invalid transition', async () => {
    const selectRequest = createRequest(async () => ({
      recordset: [
        {
          event_id: 'event-1',
          status: 'draft',
          title: 'Fly Tying 101',
          event_date: new Date().toISOString(),
          location: null,
          description: null,
        },
      ],
    }));

    const updateRequest = createRequest(async () => ({ recordset: [] }));
    const pool = {
      request: jest
        .fn()
        .mockReturnValueOnce(selectRequest)
        .mockReturnValueOnce(updateRequest),
    };
    (getPool as jest.Mock).mockResolvedValue(pool);

    const res = await request(app).put('/api/events/event-1/status').send({ status: 'completed' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Cannot transition');
    expect(updateRequest.query).not.toHaveBeenCalled();
  });

  it('POST /api/events validates required fields', async () => {
    const res = await request(app).post('/api/events').send({ title: 'Missing date' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('title and event_date are required');
  });
});
