import express from 'express';
import request from 'supertest';
import smsRouter from '../routes/sms';
import { getPool } from '../db';
import { notificationService } from '../services/notifications';
import { createRsvpToken } from '../services/rsvpLinkService';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: 'NVarChar',
    UniqueIdentifier: 'UniqueIdentifier',
  },
}));

jest.mock('../services/notifications', () => ({
  notificationService: {
    writeSmsConsentLog: jest.fn(),
    sendSms: jest.fn(),
  },
  sendRsvpConfirmation: jest.fn(),
}));

jest.mock('../middleware/rateLimiter', () => ({
  apiLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  writeLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

jest.mock('../middleware/auth', () => ({
  __esModule: true,
  default: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

jest.mock('../middleware/rbac', () => ({
  requireAdmin: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

type QueryResult = { recordset?: unknown[]; rowsAffected?: number[] };

describe('sms routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/sms', smsRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POST /api/sms/inbound handles STOP and logs opt-out', async () => {
    const queryResults: QueryResult[] = [
      { recordset: [{ member_id: 'member-1', mobile_phone: '+13035551212' }] },
      { rowsAffected: [1] },
    ];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queryResults.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .post('/api/sms/inbound')
      .send({ from: '+13035551212', message: 'STOP' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('opted_out');
    expect(notificationService.writeSmsConsentLog).toHaveBeenCalledWith(
      'member-1',
      'opt_out',
      'reply',
      'Inbound STOP message'
    );
    expect(notificationService.sendSms).toHaveBeenCalledWith(
      expect.objectContaining({ bypassOptInCheck: true, memberId: 'member-1' })
    );
    expect(mockRequest.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO dbo.inbound_sms_log'));
  });

  it('POST /api/sms/inbound records a single-event RSVP reply with explicit role', async () => {
    const queryResults: QueryResult[] = [
      { recordset: [{ member_id: 'member-1', mobile_phone: '+13035551212' }] },
      { recordset: [{ event_id: 'event-1', title: 'Climb Night', event_date: new Date('2025-01-01T18:00:00Z'), location: 'Gym' }] },
      { recordset: [{ event_id: 'event-1', title: 'Climb Night', status: 'published', mentor_capacity: null, participant_capacity: 10, capacity: 10, event_date: new Date('2025-01-01T18:00:00Z') }] },
      { recordset: [{ yes_count: 0 }] },
      { recordset: [{ reserved_count: 0, has_active_offer: 0 }] },
      { recordset: [{ response_id: 'response-1', event_id: 'event-1', member_id: 'member-1', response: 'yes', responded_at: new Date('2025-01-01T12:00:00Z'), notes: 'SMS reply received: Y' }] },
      { recordset: [{ first_name: 'Pat', email: 'pat@example.com', mobile_phone: '+13035551212', sms_opt_in: true }] },
    ];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queryResults.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .post('/api/sms/inbound')
      .send({ from: '+13035551212', message: 'Y P' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'recorded',
      member_id: 'member-1',
      event_id: 'event-1',
      response: 'yes',
    });
    expect(mockRequest.input).toHaveBeenCalledWith('response_channel', 'NVarChar', 'sms');
    expect(mockRequest.input).toHaveBeenCalledWith('response_role', 'NVarChar', 'PARTICIPANT');
  });

  it('POST /api/sms/inbound tokenized payload persists tokenized link metadata', async () => {
    const token = createRsvpToken(
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000202',
      '00000000-0000-0000-0000-000000000303'
    );
    const queryResults: QueryResult[] = [
      {
        recordset: [
          {
            event_id: '00000000-0000-0000-0000-000000000101',
            title: 'Climb Night',
            status: 'published',
            mentor_capacity: null,
            participant_capacity: 10,
            capacity: 10,
            event_date: new Date('2025-01-01T18:00:00Z'),
          },
        ],
      },
      { recordset: [{ yes_count: 0 }] },
      { recordset: [{ reserved_count: 0, has_active_offer: 0 }] },
      {
        recordset: [
          {
            response_id: 'response-2',
            event_id: '00000000-0000-0000-0000-000000000101',
            member_id: '00000000-0000-0000-0000-000000000202',
            response: 'yes',
            responded_at: new Date('2025-01-01T12:00:00Z'),
            notes: 'Recorded from tokenized RSVP link',
          },
        ],
      },
      { recordset: [{ first_name: 'Pat', email: 'pat@example.com', mobile_phone: '+13035551212', sms_opt_in: true }] },
    ];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queryResults.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .post('/api/sms/inbound')
      .send({ token, response: 'yes', response_role: 'PARTICIPANT' });

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

  it('POST /api/sms/inbound tokenized payload requires role for yes/maybe/waitlist', async () => {
    const token = createRsvpToken(
      '00000000-0000-0000-0000-000000000101',
      '00000000-0000-0000-0000-000000000202'
    );

    const res = await request(app)
      .post('/api/sms/inbound')
      .send({ token, response: 'yes' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('response_role is required');
  });

  it('POST /api/sms/inbound asks for disambiguation when multiple events are pending', async () => {
    const queryResults: QueryResult[] = [
      { recordset: [{ member_id: 'member-1', mobile_phone: '+13035551212' }] },
      {
        recordset: [
          { event_id: 'event-1', title: 'Climb Night', event_date: new Date('2025-01-01T18:00:00Z'), location: 'Gym' },
          { event_id: 'event-2', title: 'Ski Tour', event_date: new Date('2025-01-03T18:00:00Z'), location: 'Trailhead' },
        ],
      },
    ];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queryResults.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .post('/api/sms/inbound')
      .send({ from: '+13035551212', message: 'Y' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('multiple_pending_events');
    expect(notificationService.sendSms).toHaveBeenCalledWith(
      expect.objectContaining({
        memberId: 'member-1',
        bypassOptInCheck: true,
      })
    );
  });

  it('POST /api/sms/inbound returns out-of-range hint for indexed response', async () => {
    const queryResults: QueryResult[] = [
      { recordset: [{ member_id: 'member-1', mobile_phone: '+13035551212' }] },
      {
        recordset: [
          { event_id: 'event-1', title: 'Climb Night', event_date: new Date('2025-01-01T18:00:00Z'), location: 'Gym' },
          { event_id: 'event-2', title: 'Ski Tour', event_date: new Date('2025-01-03T18:00:00Z'), location: 'Trailhead' },
        ],
      },
    ];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queryResults.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .post('/api/sms/inbound')
      .send({ from: '+13035551212', message: 'Y 9' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('multiple_pending_events');
    expect(res.body.reply).toContain('out of range');
  });

  it('POST /api/sms/inbound responds to Event Grid validation requests', async () => {
    const res = await request(app)
      .post('/api/sms/inbound')
      .send([{ eventType: 'Microsoft.EventGrid.SubscriptionValidationEvent', data: { validationCode: 'abc123' } }]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ validationResponse: 'abc123' });
  });

  it('POST /api/sms/inbound responds to header-based Event Grid validation requests', async () => {
    const res = await request(app)
      .post('/api/sms/inbound')
      .set('aeg-event-type', 'SubscriptionValidation')
      .send({
        topic: '/subscriptions/test/resourceGroups/rg/providers/Microsoft.EventGrid/topics/topic',
        data: { validationCode: 'header-code-1' },
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ validationResponse: 'header-code-1' });
  });

  it('POST /api/sms/inbound processes Event Grid notification object payloads', async () => {
    const queryResults: QueryResult[] = [
      { recordset: [{ member_id: 'member-1', mobile_phone: '+13035551212' }] },
      { rowsAffected: [1] },
    ];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queryResults.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .post('/api/sms/inbound')
      .set('aeg-event-type', 'Notification')
      .send({
        eventType: 'Microsoft.Communication.SMSReceived',
        data: {
          from: '+13035551212',
          messageBody: 'STOP',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.processed).toHaveLength(1);
    expect(res.body.processed[0]).toMatchObject({ status: 'opted_out', member_id: 'member-1' });
  });

  it('GET /api/sms/inbound/logs returns inbound audit records', async () => {
    const queryResults: QueryResult[] = [
      {
        recordset: [
          {
            inbound_log_id: 'log-1',
            source: 'event_grid',
            from_phone: '+13035551212',
            processing_status: 'ignored',
            received_at: new Date('2026-03-25T00:00:00Z'),
          },
        ],
      },
    ];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queryResults.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const res = await request(app)
      .get('/api/sms/inbound/logs')
      .query({ limit: 50, source: 'event_grid' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.rows[0].inbound_log_id).toBe('log-1');
  });
});