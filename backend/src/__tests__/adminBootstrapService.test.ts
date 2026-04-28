/**
 * adminBootstrapService.test.ts
 *
 * Unit tests for the idempotent bootstrap that guarantees a working root
 * admin row in [user] regardless of database state.
 */

jest.mock('../db', () => {
  const mockSql = {
    NVarChar: jest.fn().mockImplementation((len?: number) => ({ type: 'NVarChar', length: len })),
    UniqueIdentifier: { type: 'UniqueIdentifier' },
  };
  return {
    getPool: jest.fn(),
    sql: mockSql,
  };
});

import { ensureBootstrapAdmins, backfillAzureOidByEmail } from '../services/adminBootstrapService';
import { getPool } from '../db';

function buildPool(actions: string[]) {
  let i = 0;
  const request = {
    input: jest.fn().mockReturnThis(),
    query: jest.fn(async () => {
      const action = actions[i++] ?? 'NONE';
      return { recordset: action === 'COUNT' ? [{ updated: 1 }] : [{ action }] };
    }),
  };
  return { request: jest.fn(() => request) };
}

describe('ensureBootstrapAdmins', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env['AUTH_BOOTSTRAP_ADMIN_EMAILS'];
  });

  it('is a no-op when env var is unset', async () => {
    const result = await ensureBootstrapAdmins();
    expect(result).toEqual({ ensured: [], skipped: [] });
    expect(getPool as jest.Mock).not.toHaveBeenCalled();
  });

  it('skips entries that are not valid emails', async () => {
    process.env['AUTH_BOOTSTRAP_ADMIN_EMAILS'] = 'not-an-email,, , ;';
    const result = await ensureBootstrapAdmins();
    expect(result.ensured).toEqual([]);
    expect(getPool as jest.Mock).not.toHaveBeenCalled();
  });

  it('inserts missing admins and reports them as ensured', async () => {
    process.env['AUTH_BOOTSTRAP_ADMIN_EMAILS'] = 'root@example.com, second@example.com';
    const pool = buildPool(['INSERT', 'INSERT']);
    (getPool as jest.Mock).mockResolvedValue(pool);

    const result = await ensureBootstrapAdmins();

    expect(result.ensured.sort()).toEqual(['root@example.com', 'second@example.com']);
    expect(result.skipped).toEqual([]);
    expect(pool.request).toHaveBeenCalledTimes(2);
  });

  it('does not throw when an individual MERGE fails — captures into skipped', async () => {
    process.env['AUTH_BOOTSTRAP_ADMIN_EMAILS'] = 'good@example.com bad@example.com';
    const calls: string[] = [];
    const pool = {
      request: jest.fn(() => ({
        input: jest.fn().mockReturnThis(),
        query: jest.fn(async () => {
          calls.push('called');
          if (calls.length === 2) {
            throw new Error('boom');
          }
          return { recordset: [{ action: 'INSERT' }] };
        }),
      })),
    };
    (getPool as jest.Mock).mockResolvedValue(pool);

    const result = await ensureBootstrapAdmins();

    expect(result.ensured).toEqual(['good@example.com']);
    expect(result.skipped).toEqual(['bad@example.com']);
  });

  it('promotes existing non-admin rows to admin without downgrading superadmin', async () => {
    // Issued SQL is asserted to contain the promotion guard; result.action
    // distinguishes UPDATE (promoted) from NONE (already admin/superadmin).
    process.env['AUTH_BOOTSTRAP_ADMIN_EMAILS'] = 'promote@example.com, already-admin@example.com, super@example.com';
    let issuedSql = '';
    const actions = ['UPDATE', 'NONE', 'NONE'];
    let i = 0;
    const pool = {
      request: jest.fn(() => ({
        input: jest.fn().mockReturnThis(),
        query: jest.fn(async (text: string) => {
          issuedSql = text;
          return { recordset: [{ action: actions[i++] }] };
        }),
      })),
    };
    (getPool as jest.Mock).mockResolvedValue(pool);

    const result = await ensureBootstrapAdmins();

    expect(issuedSql).toContain("LOWER(target.role) NOT IN ('admin', 'superadmin')");
    expect(issuedSql).toContain("LOWER(ISNULL(target.role, '')) = 'superadmin'");
    expect(result.ensured).toEqual(['promote@example.com']);
    expect(result.skipped.sort()).toEqual(['already-admin@example.com', 'super@example.com']);
  });
});

describe('backfillAzureOidByEmail', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns false when email or oid is empty', async () => {
    expect(await backfillAzureOidByEmail('', 'oid')).toBe(false);
    expect(await backfillAzureOidByEmail('a@b.com', '')).toBe(false);
    expect(getPool as jest.Mock).not.toHaveBeenCalled();
  });

  it('updates and returns true when row exists with NULL azure_oid', async () => {
    const pool = {
      request: jest.fn(() => ({
        input: jest.fn().mockReturnThis(),
        query: jest.fn(async () => ({ recordset: [{ updated: 1 }] })),
      })),
    };
    (getPool as jest.Mock).mockResolvedValue(pool);

    const result = await backfillAzureOidByEmail('Root@Example.COM', '  oid-123  ');
    expect(result).toBe(true);
  });

  it('returns false when no row was updated', async () => {
    const pool = {
      request: jest.fn(() => ({
        input: jest.fn().mockReturnThis(),
        query: jest.fn(async () => ({ recordset: [{ updated: 0 }] })),
      })),
    };
    (getPool as jest.Mock).mockResolvedValue(pool);

    const result = await backfillAzureOidByEmail('a@b.com', 'oid');
    expect(result).toBe(false);
  });
});
