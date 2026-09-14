import { getPool } from '../db';
import {
  createNotificationDedupeKey,
  enqueueNotification,
  runNotificationOutboxWorker,
} from '../services/notificationOutboxService';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    MAX: 'MAX',
    UniqueIdentifier: 'UniqueIdentifier',
    DateTime2: 'DateTime2',
    Int: 'Int',
    NVarChar: jest.fn((length: unknown) => `NVarChar(${String(length)})`),
  },
}));

function mockRequests(results: Array<{ recordset?: unknown[]; rowsAffected?: number[] }>) {
  const requests: Array<{ input: jest.Mock; query: jest.Mock }> = [];
  (getPool as jest.Mock).mockImplementation(async () => ({
    request: () => {
      const request = {
        input: jest.fn().mockReturnThis(),
        query: jest.fn().mockResolvedValue(results.shift() ?? { recordset: [], rowsAffected: [1] }),
      };
      requests.push(request);
      return request;
    },
  }));
  return requests;
}

describe('notification outbox service', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates deterministic dedupe keys and returns an existing duplicate id', async () => {
    const existingId = '00000000-0000-4000-8000-000000000002';
    const requests = mockRequests([{ recordset: [{ outbox_id: existingId }] }]);

    expect(createNotificationDedupeKey('reminder', 42, 'email'))
      .toBe(createNotificationDedupeKey('reminder', 42, 'email'));
    await expect(enqueueNotification({
      channel: 'email',
      payload: { to: 'member@example.com' },
      dedupeKey: createNotificationDedupeKey('reminder', 42, 'email'),
    })).resolves.toBe(existingId);

    expect(requests[0]?.query.mock.calls[0]?.[0]).toContain('ERROR_NUMBER() NOT IN (2601, 2627)');
    expect(requests[0]?.input).toHaveBeenCalledWith('dedupe_key', 'NVarChar(128)', expect.any(String));
  });

  it('claims and marks a delivered notification sent', async () => {
    const requests = mockRequests([
      { recordset: [{
        outbox_id: '00000000-0000-4000-8000-000000000003',
        tenant_id: null,
        channel: 'email',
        payload: JSON.stringify({ to: 'member@example.com' }),
        attempt_count: 1,
        lease_token: '00000000-0000-4000-8000-000000000004',
      }] },
      { rowsAffected: [1] },
    ]);
    const dispatcher = {
      deliverOutboxEmail: jest.fn().mockResolvedValue('provider-1'),
      deliverOutboxSms: jest.fn(),
    };

    await expect(runNotificationOutboxWorker(dispatcher)).resolves.toEqual({
      claimed: 1, sent: 1, retried: 0, deadLettered: 0,
    });
    expect(requests[0]?.query.mock.calls[0]?.[0]).toContain('WITH (UPDLOCK, READPAST, ROWLOCK)');
    expect(requests[1]?.query.mock.calls[0]?.[0]).toContain("SET state = 'sent'");
  });

  it.each([
    { attemptCount: 2, expectedState: 'queued', resultKey: 'retried' },
    { attemptCount: 5, expectedState: 'dead_letter', resultKey: 'deadLettered' },
  ])('retries or dead-letters a failed claim at attempt $attemptCount', async ({ attemptCount, expectedState, resultKey }) => {
    const requests = mockRequests([
      { recordset: [{
        outbox_id: '00000000-0000-4000-8000-000000000005',
        tenant_id: null,
        channel: 'sms',
        payload: JSON.stringify({ to: '+13035550001', message: 'Hello' }),
        attempt_count: attemptCount,
        lease_token: '00000000-0000-4000-8000-000000000006',
      }] },
      { rowsAffected: [1] },
    ]);
    const dispatcher = {
      deliverOutboxEmail: jest.fn(),
      deliverOutboxSms: jest.fn().mockRejectedValue(new Error('provider down')),
    };

    const result = await runNotificationOutboxWorker(dispatcher, { maxAttempts: 5, retryBaseMs: 1000 });

    expect(result[resultKey as 'retried' | 'deadLettered']).toBe(1);
    expect(requests[1]?.input).toHaveBeenCalledWith('state', 'NVarChar(20)', expectedState);
    expect(requests[1]?.input).toHaveBeenCalledWith('provider_error', 'NVarChar(4000)', 'provider down');
  });
});