import express from 'express';
import request from 'supertest';
import eventsRouter from '../routes/events';
import { getPool } from '../db';
import { createRsvpToken } from '../services/rsvpLinkService';
import { sendEventCompletedNotification, sendEventPublishedNotification, sendEventUpdatedNotification } from '../services/notifications';
import { generateInviteDraft } from '../services/aiInviteService';
import { apiLimiter } from '../middleware/rateLimiter';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: 'NVarChar',
    Int: 'Int',
    DateTime: 'DateTime',
    Bit: 'Bit',
    UniqueIdentifier: 'UniqueIdentifier',
    MAX: 'MAX',
    Transaction: jest.fn().mockImplementation((pool: { request: () => unknown }) => ({
      begin: jest.fn().mockResolvedValue(undefined),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      request: () => pool.request(),
    })),
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
  assertEventPublishedNotificationReady: jest.fn(),
  assertEventCancelledNotificationReady: jest.fn(),
  assertEventUpdatedNotificationReady: jest.fn(),
  sendEventPublishedNotification: jest.fn(),
  sendEventCancelledNotification: jest.fn(),
  sendEventUpdatedNotification: jest.fn(),
  sendEventCompletedNotification: jest.fn(),
  sendRsvpConfirmation: jest.fn(),
  notificationService: {
    sendEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../services/aiInviteService', () => ({
  generateInviteDraft: jest.fn(),
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
  app.use(apiLimiter);
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

  it('GET /api/events/:id/assignment-recommendations returns ranked equity rows', async () => {
    const mockRequest = createRequest(async () => ({
      recordset: [
        {
          member_id: 'member-1',
          first_name: 'Alex',
          last_name: 'River',
          response: 'yes',
          role_attended_year: 0,
          role_attended_prior_year: 1,
          total_attended_year: 2,
          total_attended_prior_year: 2,
        },
      ],
    }));
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .get('/api/events/event-1/assignment-recommendations?role=MENTOR&limit=5');

    expect(res.status).toBe(200);
    expect(res.body.role).toBe('MENTOR');
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.rows[0].rank).toBe(1);
    expect(mockRequest.input).toHaveBeenCalledWith('role', 'NVarChar', 'MENTOR');
  });

  it('GET /api/events/:id/assignment-recommendations applies lead+participant discount and total attended de-dupe in SQL', async () => {
    let capturedQuery = '';
    const mockRequest = createRequest(async (query) => {
      capturedQuery = query;
      return {
        recordset: [
          {
            member_id: 'member-1',
            first_name: 'Alex',
            last_name: 'River',
            response: 'yes',
            role_attended_year: 0.5,
            role_attended_prior_year: 1,
            total_attended_year: 2,
            total_attended_prior_year: 2,
          },
        ],
      };
    });
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .get('/api/events/event-1/assignment-recommendations?role=PARTICIPANT&limit=5');

    expect(res.status).toBe(200);
    expect(capturedQuery).toContain('CASE WHEN attendance.lead_attended = 1 THEN 0.5 ELSE 1 END');
    expect(capturedQuery).toContain('attendance.attended_any = 1');
  });

  it('PUT /api/events/:id/status rejects invalid transition', async () => {
    const supportRequest = createRequest(async () => ({
      recordset: [{ has_event_lead_name: 1, has_event_lead_email: 1 }],
    }));

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
        .mockReturnValueOnce(supportRequest)
        .mockReturnValueOnce(selectRequest)
        .mockReturnValueOnce(updateRequest),
    };
    (getPool as jest.Mock).mockResolvedValue(pool);

    const res = await request(app).put('/api/events/event-1/status').send({ status: 'completed' });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain('Cannot transition');
    expect(updateRequest.query).not.toHaveBeenCalled();
  });

  it('PUT /api/events/:id/status keeps status update when publish notification send fails', async () => {
    (sendEventPublishedNotification as jest.Mock).mockRejectedValueOnce(new Error('provider outage'));

    const selectRequest = createRequest(async () => ({
      recordset: [
        {
          event_id: 'event-1',
          status: 'draft',
          title: 'Fly Tying 101',
          event_date: new Date().toISOString(),
          location: null,
          description: null,
          photo_url: null,
          invitation_stage: 'both',
          event_lead_name: null,
          event_lead_email: null,
        },
      ],
    }));

    const updateRequest = createRequest(async () => ({
      recordset: [{ event_id: 'event-1', status: 'published' }],
    }));
    const targetCountRequest = createRequest(async () => ({
      recordset: [{ target_count: 1 }],
    }));

    const pool = {
      request: jest
        .fn()
        .mockReturnValueOnce(selectRequest)
        .mockReturnValueOnce(targetCountRequest)
        .mockReturnValueOnce(updateRequest),
    };
    (getPool as jest.Mock).mockResolvedValue(pool);

    const res = await request(app).put('/api/events/event-1/status').send({ status: 'published' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('published');
    expect(res.body.notification_warning).toContain('being sent in the background');
  });

  it('PUT /api/events/:id/status returns immediately while publish notifications send in background', async () => {
    (sendEventPublishedNotification as jest.Mock).mockReturnValueOnce(new Promise(() => undefined));

    const selectRequest = createRequest(async () => ({
      recordset: [
        {
          event_id: 'event-1',
          status: 'draft',
          title: 'Fly Tying 101',
          event_date: new Date().toISOString(),
          location: null,
          description: null,
          photo_url: null,
          invitation_stage: 'both',
          event_lead_name: null,
          event_lead_email: null,
        },
      ],
    }));

    const updateRequest = createRequest(async () => ({
      recordset: [{ event_id: 'event-1', status: 'published' }],
    }));
    const targetCountRequest = createRequest(async () => ({
      recordset: [{ target_count: 1 }],
    }));

    const pool = {
      request: jest
        .fn()
        .mockReturnValueOnce(selectRequest)
        .mockReturnValueOnce(targetCountRequest)
        .mockReturnValueOnce(updateRequest),
    };
    (getPool as jest.Mock).mockResolvedValue(pool);

    const res = await request(app).put('/api/events/event-1/status').send({ status: 'published' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('published');
    expect(res.body.notification_warning).toContain('being sent in the background');
    expect(sendEventPublishedNotification).toHaveBeenCalled();
  });

  it('PUT /api/events/:id/status blocks publish when no target groups are configured', async () => {
    const selectRequest = createRequest(async () => ({
      recordset: [
        {
          event_id: 'event-1',
          status: 'draft',
          title: 'Fly Tying 101',
          event_date: new Date().toISOString(),
          location: null,
          description: null,
          photo_url: null,
          invitation_stage: 'both',
          event_lead_name: null,
          event_lead_email: null,
        },
      ],
    }));
    const targetCountRequest = createRequest(async () => ({
      recordset: [{ target_count: 0 }],
    }));
    const updateRequest = createRequest(async () => ({
      recordset: [{ event_id: 'event-1', status: 'published' }],
    }));

    const pool = {
      request: jest
        .fn()
        .mockReturnValueOnce(selectRequest)
        .mockReturnValueOnce(targetCountRequest)
        .mockReturnValueOnce(updateRequest),
    };
    (getPool as jest.Mock).mockResolvedValue(pool);

    const res = await request(app).put('/api/events/event-1/status').send({ status: 'published' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('At least one target group is required');
    expect(updateRequest.query).not.toHaveBeenCalled();
  });

  it('PUT /api/events/:id/status marks LEAD assignments attended when completing event', async () => {
    const selectRequest = createRequest(async () => ({
      recordset: [
        {
          event_id: 'event-1',
          status: 'published',
          title: 'Fly Tying 101',
          event_date: new Date().toISOString(),
          location: null,
          description: null,
          photo_url: null,
          invitation_stage: 'both',
          event_lead_member_id: '00000000-0000-0000-0000-000000000099',
          event_lead_name: 'Pat Lead',
          event_lead_email: 'pat@example.com',
        },
      ],
    }));
    const updateRequest = createRequest(async () => ({
      recordset: [{ event_id: 'event-1', status: 'completed' }],
    }));
    const leadAttendanceRequest = createRequest(async () => ({ rowsAffected: [1], recordset: [] }));

    const pool = {
      request: jest
        .fn()
        .mockReturnValueOnce(selectRequest)
        .mockReturnValueOnce(updateRequest)
        .mockReturnValueOnce(leadAttendanceRequest),
    };
    (getPool as jest.Mock).mockResolvedValue(pool);

    const res = await request(app).put('/api/events/event-1/status').send({ status: 'completed' });

    expect(res.status).toBe(200);
    expect(leadAttendanceRequest.query).toHaveBeenCalledWith(expect.stringContaining("role = 'LEAD'"));
    expect(sendEventCompletedNotification).toHaveBeenCalled();
  });

  it('POST /api/events/:id/close-at-capacity locks capacity using assigned and yes RSVPs', async () => {
    const eventRequest = createRequest(async () => ({
      recordset: [{ event_id: 'event-1', status: 'published' }],
    }));
    const countsRequest = createRequest(async () => ({
      recordset: [{
        assigned_mentor_count: 2,
        assigned_participant_count: 5,
        yes_mentor_count: 1,
        yes_participant_count: 6,
      }],
    }));
    const updateRequest = createRequest(async () => ({
      recordset: [{
        event_id: 'event-1',
        mentor_capacity: 2,
        participant_capacity: 6,
        capacity: 8,
        status: 'published',
      }],
    }));

    const pool = {
      request: jest
        .fn()
        .mockReturnValueOnce(eventRequest)
        .mockReturnValueOnce(countsRequest)
        .mockReturnValueOnce(updateRequest),
    };
    (getPool as jest.Mock).mockResolvedValue(pool);

    const res = await request(app).post('/api/events/event-1/close-at-capacity').send({});

    expect(res.status).toBe(200);
    expect(updateRequest.input).toHaveBeenCalledWith('mentor_capacity', 'Int', 2);
    expect(updateRequest.input).toHaveBeenCalledWith('participant_capacity', 'Int', 6);
    expect(updateRequest.input).toHaveBeenCalledWith('capacity', 'Int', 8);
    expect(res.body.event.capacity).toBe(8);
    expect(res.body.snapshot).toEqual({
      assigned_mentor_count: 2,
      assigned_participant_count: 5,
      yes_mentor_count: 1,
      yes_participant_count: 6,
    });
  });

  it('PUT /api/events/:id does not auto-send update notifications for published events', async () => {
    const queue = [
      {
        recordset: [
          {
            status: 'published',
            title: 'Fly Tying 101',
            description: 'Intro event',
            location: 'Denver',
            event_date: '2026-04-01T18:00:00.000Z',
            end_date: null,
            capacity: 12,
          },
        ],
      },
      {
        recordset: [
          {
            event_id: 'event-1',
            title: 'Fly Tying 101',
            description: 'Intro event',
            location: 'Denver',
            event_date: '2026-04-02T18:00:00.000Z',
            end_date: null,
            capacity: 12,
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
      .put('/api/events/event-1')
      .send({ event_date: '2026-04-02T18:00:00.000Z', update_reason: 'Weather shift' });

    expect(res.status).toBe(200);
    expect(sendEventUpdatedNotification).not.toHaveBeenCalled();
  });

  it('PUT /api/events/:id skips update notifications when no tracked field changed', async () => {
    const queue = [
      {
        recordset: [
          {
            status: 'published',
            title: 'Fly Tying 101',
            description: 'Intro event',
            location: 'Denver',
            event_date: '2026-04-01T18:00:00.000Z',
            end_date: null,
            capacity: 12,
          },
        ],
      },
      {
        recordset: [
          {
            event_id: 'event-1',
            title: 'Fly Tying 101',
            description: 'Intro event',
            location: 'Denver',
            event_date: '2026-04-01T18:00:00.000Z',
            end_date: null,
            capacity: 12,
            status: 'published',
          },
        ],
      },
      { recordset: [] },
    ];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queue.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .put('/api/events/event-1')
      .send({ notification_targets: [{ group_id: '00000000-0000-4000-8000-000000000111' }] });

    expect(res.status).toBe(200);
    expect(sendEventUpdatedNotification).not.toHaveBeenCalled();
  });

  it('PUT /api/events/:id sends publish-style notifications only to newly added target groups for published events', async () => {
    const queue = [
      {
        recordset: [
          {
            status: 'published',
            title: 'Fly Tying 101',
            description: 'Intro event',
            location: 'Denver',
            photo_url: null,
            invitation_stage: 'both',
            event_lead_name: 'Pat Lead',
            event_lead_email: 'pat@example.com',
            event_date: '2026-04-01T18:00:00.000Z',
            end_date: null,
            mentor_capacity: null,
            participant_capacity: 12,
            capacity: 12,
          },
        ],
      },
      {
        recordset: [
          {
            event_id: 'event-1',
            status: 'published',
            title: 'Fly Tying 101',
            description: 'Intro event',
            location: 'Denver',
            photo_url: null,
            invitation_stage: 'both',
            event_lead_name: 'Pat Lead',
            event_lead_email: 'pat@example.com',
            event_date: '2026-04-01T18:00:00.000Z',
            end_date: null,
            mentor_capacity: null,
            participant_capacity: 12,
            capacity: 12,
          },
        ],
      },
      {
        recordset: [{ group_id: '00000000-0000-4000-8000-000000000111' }],
      },
      { recordset: [] },
      { recordset: [] },
      { recordset: [] },
    ];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queue.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .put('/api/events/event-1')
      .send({
        notification_targets: [
          { group_id: '00000000-0000-4000-8000-000000000111' },
          { group_id: '00000000-0000-4000-8000-000000000222' },
        ],
      });

    expect(res.status).toBe(200);
    expect(sendEventPublishedNotification).toHaveBeenCalledWith(
      expect.objectContaining({ event_id: 'event-1' }),
      expect.objectContaining({ targetGroupIds: ['00000000-0000-4000-8000-000000000222'], skipCooldown: true })
    );
  });

  it('POST /api/events/:id/send-update sends notifications explicitly for published events', async () => {
    const queue = [
      {
        recordset: [
          {
            event_id: 'event-1',
            status: 'published',
            title: 'Fly Tying 101',
            event_date: '2026-04-02T18:00:00.000Z',
            location: 'Denver',
            description: 'Updated logistics',
            photo_url: null,
            invitation_stage: 'both',
            event_lead_name: 'Pat Lead',
            event_lead_email: 'pat@example.com',
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
      .post('/api/events/event-1/send-update')
      .send({ update_reason: 'Parking lot changed', changed_fields: ['location'] });

    expect(res.status).toBe(200);
    expect(sendEventUpdatedNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: 'event-1',
        updateReason: 'Parking lot changed',
        changedFields: ['location'],
      })
    );
  });

  it('POST /api/events validates required fields', async () => {
    const res = await request(app).post('/api/events').send({ title: 'Missing date' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('title and event_date are required');
  });

  it('POST /api/events writes LEAD and MENTOR assignment rows when lead secondary role includes MENTOR', async () => {
    const dbMock = jest.requireMock('../db') as { sql: { NVarChar: unknown } };
    const originalNVarChar = dbMock.sql.NVarChar;
    dbMock.sql.NVarChar = ((_: unknown) => 'NVarChar') as unknown;

    const mockRequest = createRequest(async (query) => {
      if (query.includes('COL_LENGTH')) {
        return { recordset: [{ has_photo_url: 1, has_invitation_stage: 1 }] };
      }
      if (query.includes('SELECT TOP 1 m.member_id')) {
        return { recordset: [{ member_id: '11111111-1111-4111-8111-111111111111' }] };
      }
      if (query.includes('INSERT INTO event')) {
        return {
          recordset: [{
            event_id: '22222222-2222-4222-8222-222222222222',
            title: 'Lead Role Test',
          }],
        };
      }
      return { recordset: [] };
    });
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .post('/api/events')
      .send({
        title: 'Lead Role Test',
        event_date: '2026-06-21T12:00:00.000Z',
        invitation_stage: 'both',
        event_lead_member_id: '11111111-1111-4111-8111-111111111111',
        event_lead_secondary_roles: ['MENTOR'],
      });

    dbMock.sql.NVarChar = originalNVarChar;

    expect(res.status).toBe(201);

    const executedSql = mockRequest.query.mock.calls
      .map((call) => String(call[0]))
      .join('\n');

    expect(executedSql).toContain("'LEAD' AS role");
    expect(executedSql).toContain("'MENTOR' AS role");
    expect(executedSql).toContain("AND role = 'PARTICIPANT'");
  });

  it('PUT /api/events/:id rejects secondary roles when no lead member id is set', async () => {
    const mockRequest = createRequest(async (query) => {
      const q = query.toUpperCase();
      if (q.includes('COL_LENGTH')) {
        return { recordset: [{ has_photo_url: 1, has_invitation_stage: 1 }] };
      }
      if (q.includes('FROM EVENT') && q.includes('WHERE EVENT_ID = @EVENT_ID') && !q.includes('EVENT_ASSIGNMENT')) {
        return {
          recordset: [
            {
              status: 'draft',
              title: 'Capacity Guard',
              description: null,
              location: null,
              photo_url: null,
              invitation_stage: 'both',
              event_lead_member_id: null,
              event_lead_name: 'Pat Lead',
              event_lead_email: 'pat@example.com',
              event_date: new Date('2026-07-01T10:00:00.000Z'),
              end_date: null,
              mentor_capacity: 1,
              participant_capacity: 4,
              capacity: 5,
            },
          ],
        };
      }

      return { recordset: [] };
    });
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .put('/api/events/22222222-2222-4222-8222-222222222222')
      .send({ event_lead_secondary_roles: ['MENTOR'] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('event_lead_secondary_roles requires event_lead_member_id');
  });

  it('GET /api/events/rsvp/:token returns public RSVP context', async () => {
    const token = createRsvpToken('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000202');
    const mockRequest = createRequest(async () => ({
      recordset: [{
        event_id: '00000000-0000-0000-0000-000000000101',
        title: 'Fly Tying 101',
        description: 'Intro event',
        location: 'Denver',
        event_date: '2026-04-01T18:00:00.000Z',
        end_date: null,
        capacity: 12,
        status: 'published',
        member_id: '00000000-0000-0000-0000-000000000202',
        first_name: 'Pat',
        current_response: null,
      }],
    }));
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).get(`/api/events/rsvp/${token}`);

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Fly Tying 101');
    expect(res.body.member_id).toBe('00000000-0000-0000-0000-000000000202');
  });

  it('POST /api/events/rsvp/:token records a public RSVP response', async () => {
    const token = createRsvpToken(
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000202',
      '00000000-0000-0000-0000-000000000303'
    );
    const queue = [
      { recordset: [{ group_name: 'Participants' }] },
      { recordset: [{ event_id: '00000000-0000-0000-0000-000000000101', title: 'Fly Tying 101', status: 'published', mentor_capacity: null, participant_capacity: 12, capacity: 12, event_date: new Date('2026-04-01T18:00:00.000Z') }] },
      { recordset: [] },
      { recordset: [{ assigned_count: 0 }] },
      { recordset: [{ response_id: 'response-1', event_id: '00000000-0000-0000-0000-000000000101', member_id: '00000000-0000-0000-0000-000000000202', response: 'yes', responded_at: new Date('2026-03-18T12:00:00.000Z'), notes: 'Recorded from tokenized RSVP link' }] },
      { recordset: [{ first_name: 'Pat', email: 'pat@example.com', mobile_phone: '+13035551212', sms_opt_in: true }] },
      { recordset: [{ event_id: '00000000-0000-0000-0000-000000000101', title: 'Fly Tying 101', event_date: new Date('2026-04-01T18:00:00.000Z'), location: 'Denver', description: null, status: 'published', capacity: 12, mentor_capacity: null, participant_capacity: 12 }] },
      { recordset: [{ yes_count: 1, active_offers: 0 }] },
      { recordset: [] },
    ];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queue.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .post(`/api/events/rsvp/${token}`)
      .send({ response: 'yes', response_role: 'PARTICIPANT' });

    expect(res.status).toBe(200);
    expect(res.body.response).toBe('yes');
    expect(mockRequest.input).toHaveBeenCalledWith('response_channel', 'NVarChar', 'tokenized_link');
    expect(mockRequest.input).toHaveBeenCalledWith('response_role', 'NVarChar', 'PARTICIPANT');
    expect(mockRequest.input).toHaveBeenCalledWith(
      'group_context_id',
      'UniqueIdentifier',
      '00000000-0000-0000-0000-000000000303'
    );
  });

  it('GET /api/events/rsvp/:token/respond records one-click RSVP response', async () => {
    const token = createRsvpToken(
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000202',
      '00000000-0000-0000-0000-000000000303'
    );
    const queue = [
      { recordset: [{ group_name: 'Participants' }] },
      { recordset: [{ event_id: '00000000-0000-0000-0000-000000000101', title: 'Fly Tying 101', status: 'published', mentor_capacity: null, participant_capacity: 12, capacity: 12, event_date: new Date('2026-04-01T18:00:00.000Z') }] },
      { recordset: [] },
      { recordset: [{ assigned_count: 0 }] },
      { recordset: [{ response_id: 'response-3', event_id: '00000000-0000-0000-0000-000000000101', member_id: '00000000-0000-0000-0000-000000000202', response: 'yes', responded_at: new Date('2026-03-18T12:00:00.000Z'), notes: 'Recorded from tokenized RSVP link' }] },
      { recordset: [{ first_name: 'Pat', email: 'pat@example.com', mobile_phone: '+13035551212', sms_opt_in: true }] },
    ];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queue.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .get(`/api/events/rsvp/${token}/respond?response=yes&role=PARTICIPANT`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('RSVP recorded');
    expect(mockRequest.input).toHaveBeenCalledWith('response_channel', 'NVarChar', 'tokenized_link');
    expect(mockRequest.input).toHaveBeenCalledWith('response_role', 'NVarChar', 'PARTICIPANT');
  });

  it('POST /api/events/:id/rsvp records a web RSVP response channel', async () => {
    const queue = [
      {
        recordset: [
          {
            group_name: 'Participants',
          },
        ],
      },
      {
        recordset: [
          {
            event_id: '00000000-0000-0000-0000-000000000101',
            title: 'Fly Tying 101',
            status: 'published',
            mentor_capacity: null,
            participant_capacity: 12,
            capacity: 12,
            event_date: new Date('2026-04-01T18:00:00.000Z'),
          },
        ],
      },
      { recordset: [] },
      { recordset: [{ assigned_count: 0 }] },
      {
        recordset: [
          {
            response_id: 'response-2',
            event_id: '00000000-0000-0000-0000-000000000101',
            member_id: '00000000-0000-0000-0000-000000000202',
            response: 'yes',
            responded_at: new Date('2026-03-18T12:00:00.000Z'),
            notes: 'Checked in from dashboard',
          },
        ],
      },
      {
        recordset: [
          {
            first_name: 'Pat',
            email: 'pat@example.com',
            mobile_phone: '+13035551212',
            sms_opt_in: true,
          },
        ],
      },
      {
        recordset: [
          {
            event_id: '00000000-0000-0000-0000-000000000101',
            title: 'Fly Tying 101',
            event_date: new Date('2026-04-01T18:00:00.000Z'),
            location: 'Denver',
            description: null,
            status: 'published',
            capacity: 12,
            mentor_capacity: null,
            participant_capacity: 12,
          },
        ],
      },
      { recordset: [{ yes_count: 1, active_offers: 0 }] },
      { recordset: [] },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queue.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .post('/api/events/00000000-0000-0000-0000-000000000101/rsvp')
      .send({ member_id: '00000000-0000-0000-0000-000000000202', response: 'yes', response_role: 'PARTICIPANT' });

    expect(res.status).toBe(200);
    expect(res.body.response).toBe('yes');
    expect(mockRequest.input).toHaveBeenCalledWith('response_channel', 'NVarChar', 'web');
  });

  it('POST /api/events/:id/rsvp does not reject empty-role authenticated users before request validation', async () => {
    const res = await request(app)
      .post('/api/events/00000000-0000-0000-0000-000000000101/rsvp')
      .set('x-test-roles', '')
      .send({ member_id: '00000000-0000-0000-0000-000000000202', response: 'invalid' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('response must be one of');
  });

  it('GET /api/events/:id/ics downloads a calendar file', async () => {
    const mockRequest = createRequest(async () => ({
      recordset: [
        {
          event_id: '00000000-0000-0000-0000-000000000101',
          title: 'Fly Tying 101',
          description: 'Intro event',
          location: 'Denver',
          event_date: new Date('2026-04-01T18:00:00.000Z'),
          end_date: null,
          status: 'published',
        },
      ],
    }));
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).get('/api/events/00000000-0000-0000-0000-000000000101/ics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.text).toContain('BEGIN:VCALENDAR');
    expect(res.text).toContain('SUMMARY:Fly Tying 101');
  });

  it('GET /api/events/:id/report.csv exports completed event record as CSV', async () => {
    const queue = [
      {
        recordset: [
          {
            event_id: '00000000-0000-0000-0000-000000000101',
            title: 'Fly Tying 101',
            description: 'Intro event',
            location: 'Denver',
            event_date: new Date('2026-04-01T18:00:00.000Z'),
            end_date: null,
            status: 'completed',
            mentor_capacity: 1,
            participant_capacity: 12,
            capacity: 13,
            created_at: new Date('2026-03-01T00:00:00.000Z'),
            updated_at: new Date('2026-04-01T00:00:00.000Z'),
          },
        ],
      },
      { recordset: [] },
      { recordset: [] },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queue.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).get('/api/events/00000000-0000-0000-0000-000000000101/report.csv');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Event Summary');
    expect(res.text).toContain('RSVP Responses');
  });

  it('GET /api/events/:id/report.pdf exports completed event record as PDF', async () => {
    const queue = [
      {
        recordset: [
          {
            event_id: '00000000-0000-0000-0000-000000000101',
            title: 'Fly Tying 101',
            description: 'Intro event',
            location: 'Denver',
            event_date: new Date('2026-04-01T18:00:00.000Z'),
            end_date: null,
            status: 'completed',
            mentor_capacity: 1,
            participant_capacity: 12,
            capacity: 13,
            created_at: new Date('2026-03-01T00:00:00.000Z'),
            updated_at: new Date('2026-04-01T00:00:00.000Z'),
          },
        ],
      },
      { recordset: [] },
      { recordset: [] },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queue.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).get('/api/events/00000000-0000-0000-0000-000000000101/report.pdf');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toContain('.pdf');
  });

  it('POST /api/events/:id/report/email sends the pre-event lead prep summary with CC recipients', async () => {
    const notifications = jest.requireMock('../services/notifications') as {
      notificationService: { sendEmail: jest.Mock };
    };

    const queue = [
      {
        recordset: [
          {
            event_id: '00000000-0000-0000-0000-000000000101',
            title: 'Fly Tying 101',
            description: 'Intro event',
            location: 'Denver',
            event_date: new Date('2026-04-01T18:00:00.000Z'),
            end_date: null,
            status: 'published',
            event_lead_email: 'lead@example.com',
            mentor_capacity: 1,
            participant_capacity: 12,
            capacity: 13,
            created_at: new Date('2026-03-01T00:00:00.000Z'),
            updated_at: new Date('2026-04-01T00:00:00.000Z'),
          },
        ],
      },
      {
        recordset: [
          {
            assignment_id: 'assignment-1',
            member_id: 'member-1',
            first_name: 'Pat',
            last_name: 'Lead',
            email: 'pat@example.com',
            mobile_phone: '+13035551212',
            role: 'MENTOR',
            assigned_at: new Date('2026-03-18T12:00:00.000Z'),
            attended: null,
            attendance_notes: null,
          },
        ],
      },
      {
        recordset: [
          {
            response_id: 'response-1',
            member_id: 'member-2',
            first_name: 'Sam',
            last_name: 'Rider',
            email: 'sam@example.com',
            mobile_phone: null,
            response: 'yes',
            response_role: 'PARTICIPANT',
            response_channel: 'web',
            responded_at: new Date('2026-03-19T12:00:00.000Z'),
            notes: null,
          },
        ],
      },
      {
        recordset: [],
      },
      {
        recordset: [
          {
            program_lead_email: 'program@example.com',
            assistant_program_lead_email_1: 'apl1@example.com',
            assistant_program_lead_email_2: 'apl2@example.com',
          },
        ],
      },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queue.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).post('/api/events/00000000-0000-0000-0000-000000000101/report/email').send({});

    expect(res.status).toBe(200);
    expect(res.body.to).toBe('lead@example.com');
    expect(res.body.cc).toEqual(['program@example.com', 'apl1@example.com', 'apl2@example.com']);
    expect(res.body.sent).toBe(1);
    expect(notifications.notificationService.sendEmail).toHaveBeenCalledTimes(1);
    expect(notifications.notificationService.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'lead@example.com',
      cc: ['program@example.com', 'apl1@example.com', 'apl2@example.com'],
      subject: 'Lead Prep Summary: Fly Tying 101',
      eventId: '00000000-0000-0000-0000-000000000101',
      operationType: 'event_lead_prep_email',
    }));
  });

  it('POST /api/events/:id/report/email excludes lead-only assignments from roster and contact list', async () => {
    const notifications = jest.requireMock('../services/notifications') as {
      notificationService: { sendEmail: jest.Mock };
    };

    const queue = [
      {
        recordset: [
          {
            event_id: '00000000-0000-0000-0000-000000000101',
            title: 'Fly Tying 101',
            description: 'Intro event',
            location: 'Denver',
            event_date: new Date('2026-04-01T18:00:00.000Z'),
            end_date: null,
            status: 'published',
            event_lead_email: 'lead@example.com',
            mentor_capacity: 1,
            participant_capacity: 12,
            capacity: 13,
            created_at: new Date('2026-03-01T00:00:00.000Z'),
            updated_at: new Date('2026-04-01T00:00:00.000Z'),
          },
        ],
      },
      {
        recordset: [
          {
            assignment_id: 'assignment-1',
            member_id: 'member-1',
            first_name: 'Pat',
            last_name: 'Lead',
            email: 'lead-only@example.com',
            mobile_phone: '+13035551212',
            role: 'LEAD',
            assigned_at: new Date('2026-03-18T12:00:00.000Z'),
            attended: null,
            attendance_notes: null,
          },
          {
            assignment_id: 'assignment-2',
            member_id: 'member-2',
            first_name: 'Sam',
            last_name: 'Mentor',
            email: 'sam@example.com',
            mobile_phone: '+13035551213',
            role: 'MENTOR',
            assigned_at: new Date('2026-03-19T12:00:00.000Z'),
            attended: null,
            attendance_notes: null,
          },
        ],
      },
      {
        recordset: [],
      },
      {
        recordset: [],
      },
      {
        recordset: [
          {
            program_lead_email: 'program@example.com',
            assistant_program_lead_email_1: 'apl1@example.com',
            assistant_program_lead_email_2: 'apl2@example.com',
          },
        ],
      },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queue.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).post('/api/events/00000000-0000-0000-0000-000000000101/report/email').send({});

    expect(res.status).toBe(200);
    const sendPayload = notifications.notificationService.sendEmail.mock.calls[0]?.[0];
    expect(sendPayload.textBody).toContain('Sam Mentor');
    expect(sendPayload.textBody).not.toContain('Pat Lead');
    expect(sendPayload.htmlBody).toContain('sam@example.com');
    expect(sendPayload.htmlBody).not.toContain('lead-only@example.com');
  });

  it('POST /api/events/:id/participation-summary/email sends completed participation summary to scheduler with CC recipients', async () => {
    const notifications = jest.requireMock('../services/notifications') as {
      notificationService: { sendEmail: jest.Mock };
    };

    const queue = [
      {
        recordset: [
          {
            event_id: '00000000-0000-0000-0000-000000000101',
            title: 'Fly Tying 101',
            description: 'Intro event',
            location: 'Denver',
            event_date: new Date('2026-04-01T18:00:00.000Z'),
            end_date: null,
            status: 'completed',
            event_lead_email: 'lead@example.com',
            mentor_capacity: 1,
            participant_capacity: 12,
            capacity: 13,
            created_at: new Date('2026-03-01T00:00:00.000Z'),
            updated_at: new Date('2026-04-01T00:00:00.000Z'),
          },
        ],
      },
      {
        recordset: [
          {
            assignment_id: 'assignment-1',
            member_id: 'member-1',
            first_name: 'Pat',
            last_name: 'Lead',
            email: 'pat@example.com',
            mobile_phone: '+13035551212',
            role: 'MENTOR',
            assigned_at: new Date('2026-03-18T12:00:00.000Z'),
            attended: true,
            attendance_notes: null,
          },
        ],
      },
      {
        recordset: [
          {
            response_id: 'response-1',
            member_id: 'member-2',
            first_name: 'Sam',
            last_name: 'Rider',
            email: 'sam@example.com',
            mobile_phone: null,
            response: 'yes',
            response_role: 'PARTICIPANT',
            response_channel: 'web',
            responded_at: new Date('2026-03-19T12:00:00.000Z'),
            notes: null,
          },
        ],
      },
      { recordset: [] },
      {
        recordset: [
          {
            scheduler_email: 'scheduler@example.com',
            creator_email: 'creator@example.com',
            pre_event_auto_sent_at: null,
          },
        ],
      },
      { recordset: [] },
      {
        recordset: [
          {
            program_lead_email: 'program@example.com',
            assistant_program_lead_email_1: 'apl1@example.com',
            assistant_program_lead_email_2: 'apl2@example.com',
          },
        ],
      },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queue.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app).post('/api/events/00000000-0000-0000-0000-000000000101/participation-summary/email').send({});

    expect(res.status).toBe(200);
    expect(res.body.to).toBe('scheduler@example.com');
    expect(res.body.fallback_used).toBe('scheduler');
    expect(res.body.cc).toEqual(['program@example.com', 'apl1@example.com', 'apl2@example.com']);
    expect(notifications.notificationService.sendEmail).toHaveBeenCalledTimes(1);
    expect(notifications.notificationService.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'scheduler@example.com',
      cc: ['program@example.com', 'apl1@example.com', 'apl2@example.com'],
      subject: 'Participation Summary: Fly Tying 101',
      eventId: '00000000-0000-0000-0000-000000000101',
      operationType: 'event_participation_summary_email',
    }));
  });

  it('POST /api/events/:id/ai-draft returns event-scoped AI draft payload', async () => {
    (generateInviteDraft as jest.Mock).mockResolvedValue({
      subject: 'Subject',
      emailBody: 'Email body',
      smsBody: 'SMS body',
      provider: 'fallback',
      mapUrl: 'https://example.com/map',
      imageSuggestions: ['https://example.com/image'],
    });

    const queue = [
      {
        recordset: [
          {
            title: 'Fly Tying 101',
            event_date: '2026-04-01T18:00:00.000Z',
            location: 'Denver',
            description: 'Intro event',
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
      .post('/api/events/00000000-0000-0000-0000-000000000101/ai-draft')
      .send({ tone: 'professional' });

    expect(res.status).toBe(200);
    expect(res.body.subject).toBe('Subject');
    expect(res.body.tone).toBe('professional');
    expect(generateInviteDraft).toHaveBeenCalledWith(expect.objectContaining({
      eventTitle: 'Fly Tying 101',
    }));
  });
});
