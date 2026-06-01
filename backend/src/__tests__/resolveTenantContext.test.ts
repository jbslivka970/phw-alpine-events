import type { NextFunction, Request, Response } from 'express';
import { resolveTenantContext, DEFAULT_TENANT_ID } from '../middleware/resolveTenantContext';
import { listTenantsForAuthenticatedUser } from '../services/tenantContextService';

jest.mock('../services/tenantContextService', () => ({
  listTenantsForAuthenticatedUser: jest.fn(),
}));

function buildReq(overrides?: Partial<Request>): Request {
  return {
    headers: {},
    user: {
      sub: 'sub-123',
      email: 'member@example.com',
      name: 'Member',
      roles: ['USER'],
      rawClaims: {},
    },
    ...overrides,
  } as Request;
}

function buildRes(): Response {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
  };
  return res as unknown as Response;
}

describe('resolveTenantContext', () => {
  const originalNodeEnv = process.env['NODE_ENV'];
  const originalFlag = process.env['MULTI_TENANT_ENABLED'];

  beforeEach(() => {
    jest.clearAllMocks();
    process.env['NODE_ENV'] = 'development';
  });

  afterAll(() => {
    process.env['NODE_ENV'] = originalNodeEnv;
    process.env['MULTI_TENANT_ENABLED'] = originalFlag;
  });

  it('keeps default tenant when MULTI_TENANT_ENABLED is false', async () => {
    process.env['MULTI_TENANT_ENABLED'] = 'false';

    const req = buildReq({ headers: { 'x-tenant-id': '9f6bdc68-5d77-4fbe-a33a-3dcfd662d123' } });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await resolveTenantContext(req, res, next);

    expect(req.tenantId).toBe(DEFAULT_TENANT_ID);
    expect(req.tenantContext?.source).toBe('default');
    expect(listTenantsForAuthenticatedUser).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
  });

  it('uses requested tenant when enabled and membership allows it', async () => {
    process.env['MULTI_TENANT_ENABLED'] = 'true';
    (listTenantsForAuthenticatedUser as jest.Mock).mockResolvedValue([
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
      {
        tenant_id: '9f6bdc68-5d77-4fbe-a33a-3dcfd662d123',
        slug: 'demo',
        display_name: 'Demo',
        tenant_type: 'demo',
        is_demo: true,
        role: 'member',
        membership_kind: 'temporary_demo',
        expires_at: null,
        branding: null,
      },
    ]);

    const req = buildReq({ headers: { 'x-tenant-id': '9f6bdc68-5d77-4fbe-a33a-3dcfd662d123' } });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await resolveTenantContext(req, res, next);

    expect(req.tenantId).toBe('9f6bdc68-5d77-4fbe-a33a-3dcfd662d123');
    expect(req.tenantContext?.source).toBe('header');
    expect(next).toHaveBeenCalled();
  });

  it('rejects inaccessible tenant requests when enabled', async () => {
    process.env['MULTI_TENANT_ENABLED'] = 'true';
    (listTenantsForAuthenticatedUser as jest.Mock).mockResolvedValue([
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

    const req = buildReq({ headers: { 'x-tenant-id': '9f6bdc68-5d77-4fbe-a33a-3dcfd662d123' } });
    const res = buildRes();
    const next: NextFunction = jest.fn();

    await resolveTenantContext(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Requested tenant is not accessible for this account.' });
    expect(next).not.toHaveBeenCalled();
  });
});