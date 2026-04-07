import express from 'express';
import request from 'supertest';
import eventsRouter from '../routes/events';
import { getPool } from '../db';
import { createRsvpToken } from '../services/rsvpLinkService';
import { sendEventUpdatedNotification } from '../services/notifications';
import { generateInviteDraft } from '../services/aiInviteService';

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
  assertEventPublishedNotificationReady: jest.fn(),
  assertEventCancelledNotificationReady: jest.fn(),
  assertEventUpdatedNotificationReady: jest.fn(),
  sendEventPublishedNotification: jest.fn(),
  sendEventCancelledNotification: jest.fn(),
  sendEventUpdatedNotification: jest.fn(),
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

  it('PUT /api/events/:id sends update notifications for published events with changed fields', async () => {
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
    expect(sendEventUpdatedNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: 'event-1',
        updateReason: 'Weather shift',
      })
    );
    expect(sendEventUpdatedNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFields: expect.arrayContaining(['event_date']),
        changeSummary: expect.stringContaining('Event date/time: 2026-04-01T18:00:00.000Z -> 2026-04-02T18:00:00.000Z'),
      })
    );
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
      .send({ notification_targets: [{ group_id: '00000000-0000-0000-0000-000000000111' }] });

    expect(res.status).toBe(200);
    expect(sendEventUpdatedNotification).not.toHaveBeenCalled();
  });

  it('POST /api/events validates required fields', async () => {
    const res = await request(app).post('/api/events').send({ title: 'Missing date' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('title and event_date are required');
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
      { recordset: [{ event_id: '00000000-0000-0000-0000-000000000101', title: 'Fly Tying 101', status: 'published', mentor_capacity: null, participant_capacity: 12, capacity: 12, event_date: new Date('2026-04-01T18:00:00.000Z') }] },
      { recordset: [] },
      { recordset: [{ yes_count: 0 }] },
      { recordset: [{ reserved_count: 0, has_active_offer: 0 }] },
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
      { recordset: [{ event_id: '00000000-0000-0000-0000-000000000101', title: 'Fly Tying 101', status: 'published', mentor_capacity: null, participant_capacity: 12, capacity: 12, event_date: new Date('2026-04-01T18:00:00.000Z') }] },
      { recordset: [{ yes_count: 0 }] },
      { recordset: [{ reserved_count: 0, has_active_offer: 0 }] },
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
      { recordset: [{ yes_count: 0 }] },
      { recordset: [{ reserved_count: 0, has_active_offer: 0 }] },
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

  it('POST /api/events/:id/report/email sends completed event record to recipients', async () => {
    process.env['EVENT_RECORD_EMAIL_TO'] = 'lead1@example.com,lead2@example.com';
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

    const res = await request(app).post('/api/events/00000000-0000-0000-0000-000000000101/report/email').send({});

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(2);
    expect(notifications.notificationService.sendEmail).toHaveBeenCalledTimes(2);
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
