import { runRetentionJob } from '../jobs/retentionJob';
import { getPool } from '../db';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    Int: 'Int',
  },
}));

type QueryCall = {
  sql: string;
  params: Record<string, unknown>;
};

describe('retention job', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('counts candidate rows in dry-run mode', async () => {
    const calls: QueryCall[] = [];
    const request = {
      params: {} as Record<string, unknown>,
      input(name: string, _type: unknown, value: unknown) {
        this.params[name] = value;
        return this;
      },
      query: jest.fn(async (sqlText: string) => {
        calls.push({ sql: sqlText, params: { ...request.params } });
        return { recordset: [{ count_to_delete: 7 }] };
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => request });

    const results = await runRetentionJob({
      dryRun: true,
      notificationLogDays: 30,
      inboundSmsLogDays: 60,
      emailPreferenceLogDays: 90,
    });

    expect(results).toHaveLength(3);
    expect(results.every((row) => row.mode === 'dry-run')).toBe(true);
    expect(calls[0]?.sql).toContain('SELECT COUNT(*) AS count_to_delete');
    expect(calls[0]?.params['retention_days']).toBe(30);
  });

  it('deletes rows when dry-run is disabled', async () => {
    const calls: QueryCall[] = [];
    const request = {
      params: {} as Record<string, unknown>,
      input(name: string, _type: unknown, value: unknown) {
        this.params[name] = value;
        return this;
      },
      query: jest.fn(async (sqlText: string) => {
        calls.push({ sql: sqlText, params: { ...request.params } });
        return { recordset: [{ deleted_count: 5 }] };
      }),
    };

    (getPool as jest.Mock).mockResolvedValue({ request: () => request });

    const results = await runRetentionJob({
      dryRun: false,
      notificationLogDays: 30,
      inboundSmsLogDays: 0,
      emailPreferenceLogDays: 0,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      target: 'notification_log',
      mode: 'delete',
      affectedRows: 5,
    });
    expect(calls[0]?.sql).toContain('DELETE FROM notification_log');
  });
});
