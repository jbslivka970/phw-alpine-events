jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
  },
}));

import { getPool } from '../db';
import { getTenantUsageSummary } from '../services/tenantService';

describe('tenantService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('scopes legacy usage tables through tenant-owned records', async () => {
    const query = jest.fn().mockResolvedValue({
      recordset: [{
        members_total: 2,
        events_total: 0,
        event_responses_total: 0,
        notifications_total: 0,
        notification_failures_total: 0,
        email_opt_out_total: 0,
        sms_opt_out_total: 0,
      }],
    });
    const input = jest.fn().mockReturnValue({ query });
    (getPool as jest.Mock).mockResolvedValue({
      request: jest.fn(() => ({ input })),
    });

    const result = await getTenantUsageSummary('527d755c-6818-40a0-bd7f-137a91b9e54e');
    const issuedSql = query.mock.calls[0][0] as string;

    expect(input).toHaveBeenCalledWith(
      'tenant_id',
      'UniqueIdentifier',
      '527d755c-6818-40a0-bd7f-137a91b9e54e'
    );
    expect(result.members_total).toBe(2);
    expect(issuedSql).toContain('FROM dbo.tenant_membership tm');
    expect(issuedSql).toContain('INNER JOIN dbo.event e ON e.event_id = er.event_id');
    expect(issuedSql).toContain("WHERE epl.action = ''opt_out''");
    expect(issuedSql).toContain("WHERE scl.action = ''opt_out''");
    expect(issuedSql).not.toContain('SELECT @members_total = COUNT_BIG(*)');
    expect(issuedSql).not.toContain('SELECT @event_responses_total = COUNT_BIG(*)');
    expect(issuedSql).not.toContain('FROM dbo.notification_log;');
  });
});