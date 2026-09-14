const mockTransactionBegin = jest.fn();
const mockTransactionCommit = jest.fn();
const mockTransactionRollback = jest.fn();
const mockSqlInput = jest.fn();
const mockSqlQuery = jest.fn();

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: jest.fn((length: number) => `NVarChar(${length})`),
    Bit: 'Bit',
    Transaction: jest.fn().mockImplementation(() => ({
      begin: mockTransactionBegin,
      commit: mockTransactionCommit,
      rollback: mockTransactionRollback,
    })),
    Request: jest.fn().mockImplementation(() => ({
      input: mockSqlInput,
      query: mockSqlQuery,
    })),
  },
}));

import { getPool } from '../db';
import { createTenant, getTenantUsageSummary } from '../services/tenantService';

describe('tenantService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSqlInput.mockReturnThis();
  });

  it('creates the tenant and initial active admin membership in one transaction', async () => {
    (getPool as jest.Mock).mockResolvedValue({});
    mockSqlQuery.mockResolvedValue({
      recordset: [{
        tenant_id: '22222222-2222-4222-8222-222222222222',
        slug: 'montrose',
        display_name: 'Montrose',
        tenant_type: 'program',
        status: 'suspended',
        timezone: 'America/Denver',
        is_demo: 0,
        is_operational: 0,
        created_at: new Date('2026-09-14T00:00:00.000Z'),
      }],
    });

    const tenant = await createTenant({
      slug: 'montrose',
      displayName: 'Montrose',
      initialAdminEmail: 'Admin@Example.org',
      actorEmail: 'root@example.org',
    });

    const issuedSql = mockSqlQuery.mock.calls[0][0] as string;
    expect(tenant.status).toBe('suspended');
    expect(tenant.is_operational).toBe(false);
    expect(mockSqlInput).toHaveBeenCalledWith('initial_admin_email', 'NVarChar(255)', 'admin@example.org');
    expect(issuedSql).toContain("'admin',\n           'admin'");
    expect(issuedSql).toContain("'active'");
    expect(issuedSql.indexOf('INSERT INTO dbo.tenant_membership')).toBeLessThan(issuedSql.lastIndexOf('SELECT TOP (1)'));
    expect(mockTransactionCommit).toHaveBeenCalledTimes(1);
    expect(mockTransactionRollback).not.toHaveBeenCalled();
  });

  it('rolls back without committing when initial admin provisioning fails', async () => {
    (getPool as jest.Mock).mockResolvedValue({});
    mockSqlQuery.mockRejectedValue(new Error('Failed to provision initial tenant admin'));

    await expect(createTenant({
      slug: 'montrose',
      displayName: 'Montrose',
      initialAdminEmail: 'admin@example.org',
    })).rejects.toThrow('Failed to provision initial tenant admin');

    expect(mockTransactionRollback).toHaveBeenCalledTimes(1);
    expect(mockTransactionCommit).not.toHaveBeenCalled();
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