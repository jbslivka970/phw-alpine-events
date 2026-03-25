import { getPool } from '../db';
import { notificationService } from '../services/notifications';
import { runReminderJob } from '../jobs/reminderJob';

jest.mock('../db', () => ({
  getPool: jest.fn(),
}));

jest.mock('../services/notifications', () => ({
  notificationService: {
    sendEmail: jest.fn(),
    sendSms: jest.fn(),
  },
}));

describe('runReminderJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('marks reminder as sent when a notification is delivered', async () => {
    const requestCalls: Array<{ params: Record<string, unknown>; query: string }> = [];
    const rows = [
      {
        event_id: 'event-1',
        title: 'Climb Night',
        event_date: new Date('2026-01-02T18:00:00.000Z'),
        location: 'Gym',
        response_id: 'response-1',
        member_id: 'member-1',
        first_name: 'Pat',
        email: 'pat@example.com',
        email_opt_out: false,
        mobile_phone: null,
        sms_opt_in: false,
      },
    ];

    const pool = {
      request: jest.fn().mockImplementation(() => {
        const params: Record<string, unknown> = {};
        const request = {
          input: jest.fn().mockImplementation((name: string, value: unknown) => {
            params[name] = value;
            return request;
          }),
          query: jest.fn().mockImplementation(async (query: string) => {
            requestCalls.push({ params: { ...params }, query });
            if (query.includes('SELECT e.event_id')) {
              return { recordset: rows };
            }
            return { rowsAffected: [1] };
          }),
        };
        return request;
      }),
    };

    (getPool as jest.Mock).mockResolvedValue(pool);
    (notificationService.sendEmail as jest.Mock).mockResolvedValue(undefined);
    (notificationService.sendSms as jest.Mock).mockResolvedValue(undefined);

    await runReminderJob(24);

    expect(notificationService.sendEmail).toHaveBeenCalledTimes(1);
    expect(notificationService.sendSms).not.toHaveBeenCalled();

    const selectCall = requestCalls.find((call) => call.query.includes('SELECT e.event_id'));
    expect(selectCall?.params['lookAheadHours']).toBe(24);
    expect(selectCall?.query).toContain('ISNULL(er.reminder_sent, 0) = 0');

    const updateCall = requestCalls.find((call) => call.query.includes('UPDATE event_response'));
    expect(updateCall).toBeDefined();
    expect(updateCall?.params['response_id']).toBe('response-1');
  });

  it('does not mark reminder as sent when no channel is deliverable', async () => {
    const requestCalls: Array<{ params: Record<string, unknown>; query: string }> = [];
    const rows = [
      {
        event_id: 'event-1',
        title: 'Climb Night',
        event_date: new Date('2026-01-02T18:00:00.000Z'),
        location: 'Gym',
        response_id: 'response-2',
        member_id: 'member-2',
        first_name: 'Riley',
        email: null,
        email_opt_out: true,
        mobile_phone: null,
        sms_opt_in: false,
      },
    ];

    const pool = {
      request: jest.fn().mockImplementation(() => {
        const params: Record<string, unknown> = {};
        const request = {
          input: jest.fn().mockImplementation((name: string, value: unknown) => {
            params[name] = value;
            return request;
          }),
          query: jest.fn().mockImplementation(async (query: string) => {
            requestCalls.push({ params: { ...params }, query });
            if (query.includes('SELECT e.event_id')) {
              return { recordset: rows };
            }
            return { rowsAffected: [1] };
          }),
        };
        return request;
      }),
    };

    (getPool as jest.Mock).mockResolvedValue(pool);
    (notificationService.sendEmail as jest.Mock).mockResolvedValue(undefined);
    (notificationService.sendSms as jest.Mock).mockResolvedValue(undefined);

    await runReminderJob(24);

    expect(notificationService.sendEmail).not.toHaveBeenCalled();
    expect(notificationService.sendSms).not.toHaveBeenCalled();

    const updateCall = requestCalls.find((call) => call.query.includes('UPDATE event_response'));
    expect(updateCall).toBeUndefined();
  });

  it('falls back to sms when email send fails and still marks reminder as sent', async () => {
    const requestCalls: Array<{ params: Record<string, unknown>; query: string }> = [];
    const rows = [
      {
        event_id: 'event-1',
        title: 'Climb Night',
        event_date: new Date('2026-01-02T18:00:00.000Z'),
        location: 'Gym',
        response_id: 'response-3',
        member_id: 'member-3',
        first_name: 'Morgan',
        email: 'morgan@example.com',
        email_opt_out: false,
        mobile_phone: '+15555551234',
        sms_opt_in: true,
      },
    ];

    const pool = {
      request: jest.fn().mockImplementation(() => {
        const params: Record<string, unknown> = {};
        const request = {
          input: jest.fn().mockImplementation((name: string, value: unknown) => {
            params[name] = value;
            return request;
          }),
          query: jest.fn().mockImplementation(async (query: string) => {
            requestCalls.push({ params: { ...params }, query });
            if (query.includes('SELECT e.event_id')) {
              return { recordset: rows };
            }
            return { rowsAffected: [1] };
          }),
        };
        return request;
      }),
    };

    (getPool as jest.Mock).mockResolvedValue(pool);
    (notificationService.sendEmail as jest.Mock).mockRejectedValue(new Error('Email transport failed'));
    (notificationService.sendSms as jest.Mock).mockResolvedValue(undefined);

    await runReminderJob(24);

    expect(notificationService.sendEmail).toHaveBeenCalledTimes(1);
    expect(notificationService.sendSms).toHaveBeenCalledTimes(1);

    const updateCall = requestCalls.find((call) => call.query.includes('UPDATE event_response'));
    expect(updateCall).toBeDefined();
    expect(updateCall?.params['response_id']).toBe('response-3');
  });

  it('continues processing subsequent rows when one row delivery fails', async () => {
    const requestCalls: Array<{ params: Record<string, unknown>; query: string }> = [];
    const rows = [
      {
        event_id: 'event-1',
        title: 'Climb Night',
        event_date: new Date('2026-01-02T18:00:00.000Z'),
        location: 'Gym',
        response_id: 'response-4',
        member_id: 'member-4',
        first_name: 'Casey',
        email: 'casey@example.com',
        email_opt_out: false,
        mobile_phone: null,
        sms_opt_in: false,
      },
      {
        event_id: 'event-2',
        title: 'Trail Ride',
        event_date: new Date('2026-01-03T18:00:00.000Z'),
        location: 'Ridge',
        response_id: 'response-5',
        member_id: 'member-5',
        first_name: 'Avery',
        email: 'avery@example.com',
        email_opt_out: false,
        mobile_phone: null,
        sms_opt_in: false,
      },
    ];

    const pool = {
      request: jest.fn().mockImplementation(() => {
        const params: Record<string, unknown> = {};
        const request = {
          input: jest.fn().mockImplementation((name: string, value: unknown) => {
            params[name] = value;
            return request;
          }),
          query: jest.fn().mockImplementation(async (query: string) => {
            requestCalls.push({ params: { ...params }, query });
            if (query.includes('SELECT e.event_id')) {
              return { recordset: rows };
            }
            return { rowsAffected: [1] };
          }),
        };
        return request;
      }),
    };

    (getPool as jest.Mock).mockResolvedValue(pool);
    (notificationService.sendEmail as jest.Mock)
      .mockRejectedValueOnce(new Error('first row failed'))
      .mockResolvedValueOnce(undefined);
    (notificationService.sendSms as jest.Mock).mockResolvedValue(undefined);

    await runReminderJob(24);

    expect(notificationService.sendEmail).toHaveBeenCalledTimes(2);

    const updateCalls = requestCalls.filter((call) => call.query.includes('UPDATE event_response'));
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.params['response_id']).toBe('response-5');
  });
});
