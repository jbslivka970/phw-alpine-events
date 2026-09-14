import { getPool } from '../db';
import { runWithJobLease } from '../services/jobLeaseService';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: jest.fn((length: number) => `NVarChar(${length})`),
    UniqueIdentifier: 'UniqueIdentifier',
    Int: 'Int',
  },
}));

function mockPoolWithResults(results: Array<{ recordset?: unknown[]; rowsAffected?: number[] }>) {
  const requests: Array<{ input: jest.Mock; query: jest.Mock }> = [];
  (getPool as jest.Mock).mockImplementation(async () => ({
    request: () => {
      const request = {
        input: jest.fn().mockReturnThis(),
        query: jest.fn().mockResolvedValue(results.shift() ?? { recordset: [], rowsAffected: [0] }),
      };
      requests.push(request);
      return request;
    },
  }));
  return requests;
}

describe('runWithJobLease', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips execution when another replica holds the lease', async () => {
    mockPoolWithResults([{ recordset: [] }]);
    const job = jest.fn();

    await expect(runWithJobLease('reminder', job)).resolves.toBe(false);

    expect(job).not.toHaveBeenCalled();
  });

  it('runs once and records completion when the lease is acquired', async () => {
    const requests = mockPoolWithResults([
      { recordset: [{ lease_token: '00000000-0000-4000-8000-000000000001' }] },
      { rowsAffected: [1] },
    ]);
    const job = jest.fn().mockResolvedValue(12);

    await expect(runWithJobLease('reminder', job)).resolves.toBe(true);

    expect(job).toHaveBeenCalledTimes(1);
    expect(requests[1]?.input).toHaveBeenCalledWith('last_status', 'NVarChar(20)', 'completed');
  });
});