import type { NextFunction, Request, Response } from 'express';
import { requireAdmin, requireEventCreatorOrAdmin, requireTavfCreator } from '../middleware/rbac';
import type { TenantRole } from '../services/tenantContextService';

function buildRequest(activeRole: TenantRole, roles: NonNullable<Request['user']>['roles'] = ['USER']): Request {
  return {
    user: { sub: 'subject-1', roles, rawClaims: {} },
    tenantContext: {
      activeTenantId: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
      availableTenantIds: ['1b6b9719-663a-4e56-8f7d-9a4bd4c10001'],
      activeRole,
      source: 'header',
    },
  } as Request;
}

function buildResponse(): Response {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;
}

describe('tenant-aware RBAC', () => {
  const originalMultiTenant = process.env['MULTI_TENANT_ENABLED'];
  const originalRequireMembership = process.env['MULTI_TENANT_REQUIRE_MEMBERSHIP'];

  beforeEach(() => {
    process.env['MULTI_TENANT_ENABLED'] = 'true';
    process.env['MULTI_TENANT_REQUIRE_MEMBERSHIP'] = 'true';
  });

  afterAll(() => {
    process.env['MULTI_TENANT_ENABLED'] = originalMultiTenant;
    process.env['MULTI_TENANT_REQUIRE_MEMBERSHIP'] = originalRequireMembership;
  });

  it('denies a global admin role when the active tenant membership is member', () => {
    const res = buildResponse();
    const next: NextFunction = jest.fn();

    requireAdmin(buildRequest('member', ['ADMIN']), res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows the active tenant admin regardless of global roles', () => {
    const next: NextFunction = jest.fn();

    requireAdmin(buildRequest('admin'), buildResponse(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('allows event creators on event-creator-or-admin routes', () => {
    const next: NextFunction = jest.fn();

    requireEventCreatorOrAdmin(buildRequest('event_creator'), buildResponse(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('limits TAVF creation to creator or admin tenant roles', () => {
    const deniedNext: NextFunction = jest.fn();
    const allowedNext: NextFunction = jest.fn();

    requireTavfCreator(buildRequest('member'), buildResponse(), deniedNext);
    requireTavfCreator(buildRequest('tavf_creator'), buildResponse(), allowedNext);

    expect(deniedNext).not.toHaveBeenCalled();
    expect(allowedNext).toHaveBeenCalledTimes(1);
  });
});