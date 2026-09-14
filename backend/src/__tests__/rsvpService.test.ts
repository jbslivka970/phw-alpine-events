import { getPool } from '../db';
import { recordRsvpResponse } from '../services/rsvpService';
import { sendRsvpConfirmation, sendRsvpWaitlisted, sendWaitlistPromotionNotification } from '../services/notifications';

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
  sendRsvpWaitlisted: jest.fn(),
  sendWaitlistPromotionNotification: jest.fn(),
}));

describe('rsvpService waitlist auto-promotion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('creates a waitlist promotion offer when a yes response frees capacity', async () => {
    const queryCalls: string[] = [];
    const queue: Array<{ recordset?: unknown[]; rowsAffected?: number[] }> = [
      { recordset: [{ group_name: 'PARTICIPANTS' }] },
      { recordset: [{ event_id: 'event-1', title: 'River Day', status: 'published', mentor_capacity: null, participant_capacity: 2, capacity: 2, event_date: new Date('2026-06-01T18:00:00Z') }] },
      { recordset: [{ membership_allowed: 1 }] },
      { recordset: [] },
      { recordset: [] },
      { recordset: [{ response_id: 'r1', event_id: 'event-1', member_id: 'member-yes', response: 'no', responded_at: new Date('2026-05-01T00:00:00Z'), notes: null }] },
      { recordset: [] },
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
      { recordset: [{ group_name: 'PARTICIPANTS' }] },
      { recordset: [{ event_id: 'event-2', title: 'Casting Clinic', status: 'published', mentor_capacity: null, participant_capacity: 3, capacity: 3, event_date: new Date('2026-06-02T18:00:00Z') }] },
      { recordset: [{ membership_allowed: 1 }] },
      { recordset: [{ response: 'no', response_role: 'PARTICIPANT' }] },
      { recordset: [{ assigned_count: 2 }] },
      { recordset: [{ response_id: 'r2', event_id: 'event-2', member_id: 'member-offered', response: 'yes', responded_at: new Date('2026-05-01T00:00:00Z'), notes: null }] },
      { recordset: [] },
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
      { recordset: [{ group_name: 'PARTICIPANTS' }] },
      { recordset: [{ event_id: 'event-3', title: 'River Day', status: 'published', mentor_capacity: null, participant_capacity: 5, capacity: 5, event_date: new Date('2026-06-03T18:00:00Z') }] },
      { recordset: [{ membership_allowed: 1 }] },
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

  it('routes yes RSVP to waitlist when role capacity is full', async () => {
    const queue: Array<{ recordset?: unknown[]; rowsAffected?: number[] }> = [
      { recordset: [{ group_name: 'PARTICIPANTS' }] },
      { recordset: [{ event_id: 'event-cap', title: 'Capacity Event', status: 'published', mentor_capacity: null, participant_capacity: 1, capacity: 1, event_date: new Date('2026-06-04T18:00:00Z') }] },
      { recordset: [{ membership_allowed: 1 }] },
      { recordset: [] },
      { recordset: [{ assigned_count: 1 }] },
      { recordset: [{ response_id: 'r-cap', event_id: 'event-cap', member_id: 'member-overflow', response: 'waitlist', responded_at: new Date('2026-05-01T00:00:00Z'), notes: null }] },
      { recordset: [] },
      { recordset: [{ first_name: 'Wait', email: 'wait@example.com', mobile_phone: null, sms_opt_in: false }] },
      { recordset: [{ event_id: 'event-cap', title: 'Capacity Event', event_date: new Date('2026-06-04T18:00:00Z'), location: 'Deck', description: 'Desc', status: 'published', mentor_capacity: null, participant_capacity: 1, capacity: 1 }] },
      { rowsAffected: [0] },
      { recordset: [{ yes_count: 1, active_offers: 0 }] },
      { recordset: [] },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => {
        return queue.shift() ?? { recordset: [] };
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    const result = await recordRsvpResponse({
      eventId: 'event-cap',
      memberId: 'member-overflow',
      response: 'yes',
      responseChannel: 'web',
      responseRole: 'PARTICIPANT',
    });

    expect(result.response).toBe('waitlist');
    expect(mockRequest.input).toHaveBeenCalledWith('response', 'NVarChar', 'waitlist');
    expect(sendRsvpWaitlisted).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'event-cap' }));
  });

  it('rejects RSVP when requested role is outside member eligibility', async () => {
    const queue: Array<{ recordset?: unknown[]; rowsAffected?: number[] }> = [
      { recordset: [{ group_name: 'PARTICIPANTS' }] },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => {
        return queue.shift() ?? { recordset: [] };
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    await expect(
      recordRsvpResponse({
        eventId: 'event-4',
        memberId: 'member-role-mismatch',
        response: 'yes',
        responseChannel: 'web',
        responseRole: 'MENTOR',
      })
    ).rejects.toMatchObject({
      name: 'RsvpError',
      statusCode: 403,
    });

    expect(sendRsvpConfirmation).not.toHaveBeenCalled();
  });

  it('requires confirmation before an assigned member can decline', async () => {
    const queue: Array<{ recordset?: unknown[] }> = [
      { recordset: [{ group_name: 'VOLUNTEERS' }] },
      { recordset: [{ event_id: 'event-assigned', title: 'Assigned Event', status: 'published', mentor_capacity: 2, participant_capacity: 2, capacity: 4, event_date: new Date('2026-06-04T18:00:00Z') }] },
      { recordset: [{ membership_allowed: 1 }] },
      { recordset: [{ response: 'yes', response_role: 'MENTOR' }] },
      { recordset: [{ assignment_id: 'assignment-1' }] },
    ];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => queue.shift() ?? { recordset: [] }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    await expect(recordRsvpResponse({
      eventId: 'event-assigned',
      memberId: 'member-assigned',
      response: 'no',
      responseChannel: 'tokenized_link',
      responseRole: 'MENTOR',
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('allows RSVP when member is directly targeted by event invite without role groups', async () => {
    const queue: Array<{ recordset?: unknown[]; rowsAffected?: number[] }> = [
      { recordset: [] },
      { recordset: [{ target_id: 'target-1' }] },
      { recordset: [{ event_id: 'event-5', title: 'Direct Invite Event', status: 'published', mentor_capacity: null, participant_capacity: null, capacity: null, event_date: new Date('2026-06-05T18:00:00Z') }] },
      { recordset: [{ membership_allowed: 1 }] },
      { recordset: [] },
      { recordset: [{ response_id: 'r5', event_id: 'event-5', member_id: 'member-direct', response: 'yes', responded_at: new Date('2026-05-01T00:00:00Z'), notes: null }] },
      { recordset: [] },
      { recordset: [] },
      { rowsAffected: [0] },
      { recordset: [] },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => {
        return queue.shift() ?? { recordset: [] };
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    await expect(
      recordRsvpResponse({
        eventId: 'event-5',
        memberId: 'member-direct',
        response: 'yes',
        responseChannel: 'tokenized_link',
        responseRole: 'PARTICIPANT',
      })
    ).resolves.toMatchObject({
      response_id: 'r5',
      event_id: 'event-5',
      member_id: 'member-direct',
      response: 'yes',
    });
  });

  it('allows RSVP when member is targeted via event target group without role groups', async () => {
    const queryCalls: string[] = [];
    const queue: Array<{ recordset?: unknown[]; rowsAffected?: number[] }> = [
      { recordset: [] },
      { recordset: [{ target_id: 'target-group-1' }] },
      { recordset: [{ event_id: 'event-6', title: 'Group Invite Event', status: 'published', mentor_capacity: null, participant_capacity: null, capacity: null, event_date: new Date('2026-06-06T18:00:00Z') }] },
      { recordset: [{ membership_allowed: 1 }] },
      { recordset: [] },
      { recordset: [{ response_id: 'r6', event_id: 'event-6', member_id: 'member-group-targeted', response: 'yes', responded_at: new Date('2026-05-01T00:00:00Z'), notes: null }] },
      { recordset: [] },
      { recordset: [] },
      { rowsAffected: [0] },
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

    await expect(
      recordRsvpResponse({
        eventId: 'event-6',
        memberId: 'member-group-targeted',
        response: 'yes',
        responseChannel: 'tokenized_link',
        responseRole: 'PARTICIPANT',
      })
    ).resolves.toMatchObject({
      response_id: 'r6',
      event_id: 'event-6',
      member_id: 'member-group-targeted',
      response: 'yes',
    });

    expect(queryCalls.some((query) => query.includes('LEFT JOIN member_group'))).toBe(true);
  });

  it('allows ungrouped member self RSVP as participant when explicitly enabled', async () => {
    const queue: Array<{ recordset?: unknown[]; rowsAffected?: number[] }> = [
      { recordset: [] },
      { recordset: [{ event_id: 'event-7', title: 'Open RSVP Event', status: 'published', mentor_capacity: null, participant_capacity: null, capacity: null, event_date: new Date('2026-06-07T18:00:00Z') }] },
      { recordset: [{ membership_allowed: 1 }] },
      { recordset: [] },
      { recordset: [{ response_id: 'r7', event_id: 'event-7', member_id: 'member-ungrouped', response: 'yes', responded_at: new Date('2026-05-01T00:00:00Z'), notes: null }] },
      { recordset: [] },
      { recordset: [] },
      { rowsAffected: [0] },
      { recordset: [] },
    ];

    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async () => {
        return queue.shift() ?? { recordset: [] };
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    await expect(
      recordRsvpResponse({
        eventId: 'event-7',
        memberId: 'member-ungrouped',
        response: 'yes',
        responseChannel: 'web',
        responseRole: 'PARTICIPANT',
        allowUngroupedParticipant: true,
      })
    ).resolves.toMatchObject({
      response_id: 'r7',
      event_id: 'event-7',
      member_id: 'member-ungrouped',
      response: 'yes',
    });
  });

  it('rejects RSVP when the member lacks active membership in the event tenant', async () => {
    const queryCalls: string[] = [];
    const queue: Array<{ recordset?: unknown[] }> = [
      { recordset: [{ group_name: 'PARTICIPANTS' }] },
      { recordset: [{ event_id: 'event-tenant', tenant_id: '11111111-1111-4111-8111-111111111111', title: 'Tenant Event', status: 'published', mentor_capacity: null, participant_capacity: null, capacity: null, event_date: new Date('2026-06-08T18:00:00Z') }] },
      { recordset: [{ membership_allowed: 0 }] },
    ];
    const mockRequest = {
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockImplementation(async (query: string) => {
        queryCalls.push(query);
        return queue.shift() ?? { recordset: [] };
      }),
    };
    (getPool as jest.Mock).mockResolvedValue({ request: () => mockRequest });

    await expect(recordRsvpResponse({
      eventId: 'event-tenant',
      memberId: '22222222-2222-4222-8222-222222222222',
      response: 'yes',
      responseChannel: 'sms',
    })).rejects.toMatchObject({ statusCode: 403 });

    expect(queryCalls.some((query) => query.includes('dbo.tenant_membership'))).toBe(true);
    expect(queryCalls.some((query) => query.includes('MERGE event_response'))).toBe(false);
    expect(sendRsvpConfirmation).not.toHaveBeenCalled();
  });
});
