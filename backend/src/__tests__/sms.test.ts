import express from 'express';
import request from 'supertest';
import smsRouter from '../routes/sms';
import { getPool } from '../db';
import { notificationService } from '../services/notifications';

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
  writeLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
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
  });

  it('POST /api/sms/inbound records a single-event RSVP reply', async () => {
    const queryResults: QueryResult[] = [
      { recordset: [{ member_id: 'member-1', mobile_phone: '+13035551212' }] },
      { recordset: [{ event_id: 'event-1', title: 'Climb Night', event_date: new Date('2025-01-01T18:00:00Z'), location: 'Gym' }] },
      { recordset: [{ event_id: 'event-1', title: 'Climb Night', status: 'published', capacity: 10, event_date: new Date('2025-01-01T18:00:00Z') }] },
      { recordset: [{ yes_count: 0 }] },
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
      .send({ from: '+13035551212', message: 'Y' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'recorded',
      member_id: 'member-1',
      event_id: 'event-1',
      response: 'yes',
    });
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

  it('POST /api/sms/inbound responds to Event Grid validation requests', async () => {
    const res = await request(app)
      .post('/api/sms/inbound')
      .send([{ eventType: 'Microsoft.EventGrid.SubscriptionValidationEvent', data: { validationCode: 'abc123' } }]);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ validationResponse: 'abc123' });
  });
});