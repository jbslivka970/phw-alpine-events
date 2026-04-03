import { getPool } from '../db';
import { recordRsvpResponse } from '../services/rsvpService';
import { sendRsvpConfirmation, sendWaitlistPromotionNotification } from '../services/notifications';

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
  sendRsvpConfirmation: jest.fn(),
  sendWaitlistPromotionNotification: jest.fn(),
}));

describe('rsvpService waitlist auto-promotion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a waitlist promotion offer when a yes response frees capacity', async () => {
    const queryCalls: string[] = [];
    const queue: Array<{ recordset?: unknown[]; rowsAffected?: number[] }> = [
      { recordset: [{ event_id: 'event-1', title: 'River Day', status: 'published', mentor_capacity: null, participant_capacity: 2, capacity: 2, event_date: new Date('2026-06-01T18:00:00Z') }] },
      { recordset: [] },
      { recordset: [{ response_id: 'r1', event_id: 'event-1', member_id: 'member-yes', response: 'no', responded_at: new Date('2026-05-01T00:00:00Z'), notes: null }] },
      { recordset: [{ first_name: 'Pat', email: 'pat@example.com', mobile_phone: null, sms_opt_in: false }] },
      { rowsAffected: [0] },
      { recordset: [{ event_id: 'event-1', title: 'River Day', event_date: new Date('2026-06-01T18:00:00Z'), location: 'Deck', description: 'Desc', status: 'published', mentor_capacity: null, participant_capacity: 2, capacity: 2 }] },
      { rowsAffected: [1] },
      { recordset: [{ yes_count: 1, active_offers: 0 }] },
      { recordset: [{ member_id: 'member-wait', response_channel: 'sms', responded_at: new Date('2026-05-01T00:00:00Z'), first_name: 'Casey', email: 'casey@example.com', mobile_phone: '+13035550111', sms_opt_in: true, email_opt_out: false }] },
      { rowsAffected: [1] },
      { recordset: [{ expires_at: new Date('2026-05-02T00:00:00Z') }] },
      { recordset: [] },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async (query: string) => {
        queryCalls.push(query);
        return queue.shift() ?? { recordset: [] };
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    await recordRsvpResponse({
      eventId: 'event-1',
      memberId: 'member-yes',
      response: 'no',
      responseChannel: 'web',
    });

    expect(queryCalls.some((q) => q.includes('INSERT INTO waitlist_promotion_offer'))).toBe(true);
    expect(mockRequest.input).toHaveBeenCalledWith('offered_until_hours', 'Int', 48);
    expect(sendWaitlistPromotionNotification).toHaveBeenCalledTimes(1);
    expect(sendRsvpConfirmation).toHaveBeenCalledTimes(1);
  });

  it('marks active offers accepted when offered member responds yes', async () => {
    const queryCalls: string[] = [];
    const queue: Array<{ recordset?: unknown[]; rowsAffected?: number[] }> = [
      { recordset: [{ event_id: 'event-2', title: 'Casting Clinic', status: 'published', mentor_capacity: null, participant_capacity: 3, capacity: 3, event_date: new Date('2026-06-02T18:00:00Z') }] },
      { recordset: [{ response: 'no', response_role: 'PARTICIPANT' }] },
      { recordset: [{ yes_count: 2 }] },
      { recordset: [{ reserved_count: 0, has_active_offer: 1 }] },
      { recordset: [{ response_id: 'r2', event_id: 'event-2', member_id: 'member-offered', response: 'yes', responded_at: new Date('2026-05-01T00:00:00Z'), notes: null }] },
      { recordset: [{ first_name: 'Offered', email: 'offered@example.com', mobile_phone: null, sms_opt_in: false }] },
      { rowsAffected: [1] },
      { recordset: [{ event_id: 'event-2', title: 'Casting Clinic', event_date: new Date('2026-06-02T18:00:00Z'), location: 'Lake', description: 'Desc', status: 'published', mentor_capacity: null, participant_capacity: 3, capacity: 3 }] },
      { rowsAffected: [0] },
      { recordset: [{ yes_count: 3, active_offers: 0 }] },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async (query: string) => {
        queryCalls.push(query);
        return queue.shift() ?? { recordset: [] };
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    await recordRsvpResponse({
      eventId: 'event-2',
      memberId: 'member-offered',
      response: 'yes',
      responseChannel: 'sms',
    });

    expect(queryCalls.some((q) => q.includes("SET status = @status") && q.includes('waitlist_promotion_offer'))).toBe(true);
  });

  it('does not send duplicate RSVP confirmation for identical repeated response', async () => {
    const queue: Array<{ recordset?: unknown[]; rowsAffected?: number[] }> = [
      { recordset: [{ event_id: 'event-3', title: 'River Day', status: 'published', mentor_capacity: null, participant_capacity: 5, capacity: 5, event_date: new Date('2026-06-03T18:00:00Z') }] },
      { recordset: [{ response: 'yes', response_role: 'PARTICIPANT' }] },
      { recordset: [{ response_id: 'r3', event_id: 'event-3', member_id: 'member-repeat', response: 'yes', responded_at: new Date('2026-05-01T00:00:00Z'), notes: null }] },
      { recordset: [{ first_name: 'Repeat', email: 'repeat@example.com', mobile_phone: null, sms_opt_in: false }] },
      { rowsAffected: [0] },
      { recordset: [{ event_id: 'event-3', title: 'River Day', event_date: new Date('2026-06-03T18:00:00Z'), location: 'Deck', description: 'Desc', status: 'published', mentor_capacity: null, participant_capacity: 5, capacity: 5 }] },
      { rowsAffected: [0] },
      { recordset: [{ yes_count: 1, active_offers: 0 }] },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => {
        return queue.shift() ?? { recordset: [] };
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    await recordRsvpResponse({
      eventId: 'event-3',
      memberId: 'member-repeat',
      response: 'yes',
      responseChannel: 'tokenized_link',
      responseRole: 'PARTICIPANT',
    });

    expect(sendRsvpConfirmation).not.toHaveBeenCalled();
  });
});