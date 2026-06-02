jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    NVarChar: (_length?: number) => 'NVarChar',
  },
}));

import { getPool } from '../db';
import { listTenantsForAuthenticatedUser } from '../services/tenantContextService';

type QueryResult = {
  recordset?: unknown[];
};

function mockPoolWithResults(results: QueryResult[]) {
  const request = {
    input: jest.fn().mockReturnThis(),
    query: jest.fn().mockImplementation(async () => results.shift() ?? { recordset: [] }),
  };

  (getPool as jest.Mock).mockResolvedValue({
    request: () => request,
  });

  return request;
}

describe('tenantContextService', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('falls back to the default home tenant when tenant tables are unavailable', async () => {
    const dbRequest = mockPoolWithResults([
      { recordset: [{ tenant_tables_ready: 0 }] },
    ]);

    const tenants = await listTenantsForAuthenticatedUser({
      sub: 'sub-admin',
      email: 'admin@example.com',
      roles: ['ADMIN'],
    });

    expect(tenants).toEqual([
      {
        tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
        slug: 'colorado-alpine',
        display_name: 'Colorado Alpine',
        tenant_type: 'program',
        is_demo: false,
        role: 'admin',
        membership_kind: 'home',
        expires_at: null,
        branding: null,
      },
    ]);
    expect(dbRequest.query).toHaveBeenCalledTimes(1);
  });

  it('returns active tenant memberships when tenant tables are available', async () => {
    const expiry = new Date('2026-06-01T00:00:00.000Z');

    const dbRequest = mockPoolWithResults([
      { recordset: [{ tenant_tables_ready: 1 }] },
      {
        recordset: [
          {
            tenant_id: '00000000-0000-4000-8000-000000000777',
            slug: 'demo',
            display_name: 'Demo',
            tenant_type: 'demo',
            is_demo: 1,
            role: 'member',
            membership_kind: 'temporary_demo',
            expires_at: expiry,
            org_short_name: 'PHW Demo',
            primary_color: '#00758d',
            logo_url: 'https://cdn.example.org/demo-logo.svg',
          },
        ],
      },
    ]);

    const tenants = await listTenantsForAuthenticatedUser({
      sub: 'sub-user',
      email: 'user@example.com',
      roles: ['USER'],
    });

    expect(tenants).toEqual([
      {
        tenant_id: '00000000-0000-4000-8000-000000000777',
        slug: 'demo',
        display_name: 'Demo',
        tenant_type: 'demo',
        is_demo: true,
        role: 'member',
        membership_kind: 'temporary_demo',
        expires_at: expiry.toISOString(),
        branding: {
          org_short_name: 'PHW Demo',
          primary_color: '#00758d',
          logo_url: 'https://cdn.example.org/demo-logo.svg',
        },
      },
    ]);
    expect(dbRequest.query).toHaveBeenCalledTimes(2);
  });

  it('falls back to the default home tenant when multi-tenant mode is enabled and no memberships exist', async () => {
    process.env['MULTI_TENANT_ENABLED'] = 'true';

    const dbRequest = mockPoolWithResults([
      { recordset: [{ tenant_tables_ready: 1 }] },
      { recordset: [] },
    ]);

    const tenants = await listTenantsForAuthenticatedUser({
      sub: 'sub-user',
      email: 'user@example.com',
      roles: ['USER'],
    });

    expect(tenants).toEqual([
      {
        tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
        slug: 'colorado-alpine',
        display_name: 'Colorado Alpine',
        tenant_type: 'program',
        is_demo: false,
        role: 'member',
        membership_kind: 'home',
        expires_at: null,
        branding: null,
      },
    ]);
    expect(dbRequest.query).toHaveBeenCalledTimes(2);
  });

  it('returns an empty list when strict membership mode is enabled and no memberships exist', async () => {
    process.env['MULTI_TENANT_ENABLED'] = 'true';
    process.env['MULTI_TENANT_REQUIRE_MEMBERSHIP'] = 'true';

    const dbRequest = mockPoolWithResults([
      { recordset: [{ tenant_tables_ready: 1 }] },
      { recordset: [] },
    ]);

    const tenants = await listTenantsForAuthenticatedUser({
      sub: 'sub-user',
      email: 'user@example.com',
      roles: ['USER'],
    });

    expect(tenants).toEqual([]);
    expect(dbRequest.query).toHaveBeenCalledTimes(2);
  });

  it('falls back to default home tenant when multi-tenant mode is disabled and no memberships exist', async () => {
    process.env['MULTI_TENANT_ENABLED'] = 'false';

    const dbRequest = mockPoolWithResults([
      { recordset: [{ tenant_tables_ready: 1 }] },
      { recordset: [] },
    ]);

    const tenants = await listTenantsForAuthenticatedUser({
      sub: 'sub-user',
      email: 'user@example.com',
      roles: ['EVENT_CREATOR'],
    });

    expect(tenants).toEqual([
      {
        tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
        slug: 'colorado-alpine',
        display_name: 'Colorado Alpine',
        tenant_type: 'program',
        is_demo: false,
        role: 'event_creator',
        membership_kind: 'home',
        expires_at: null,
        branding: null,
      },
    ]);
    expect(dbRequest.query).toHaveBeenCalledTimes(2);
  });
});
