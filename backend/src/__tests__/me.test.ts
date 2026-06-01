import express from 'express';
import request from 'supertest';
import meRouter from '../routes/me';
import { listTenantsForAuthenticatedUser } from '../services/tenantContextService';

let mockUser: express.Request['user'] | undefined;

jest.mock('../middleware/auth', () => ({
  __esModule: true,
  default: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (mockUser) {
      req.user = mockUser;
    }
    next();
  },
}));

jest.mock('../middleware/rateLimiter', () => ({
  apiLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

jest.mock('../services/tenantContextService', () => ({
  listTenantsForAuthenticatedUser: jest.fn(),
}));

describe('me routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/me', meRouter);

  beforeEach(() => {
    jest.clearAllMocks();
    mockUser = {
      sub: 'sub-member',
      email: 'member@example.com',
      roles: ['USER'],
      rawClaims: {},
    } as express.Request['user'];
  });

  it('GET /api/v1/me/tenants returns tenant context for authenticated users', async () => {
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

    const res = await request(app).get('/api/v1/me/tenants');

    expect(res.status).toBe(200);
    expect(res.body.tenants).toHaveLength(1);
    expect(listTenantsForAuthenticatedUser).toHaveBeenCalledWith({
      sub: 'sub-member',
      email: 'member@example.com',
      roles: ['USER'],
    });
  });

  it('GET /api/v1/me/tenants rejects when authentication does not attach a user', async () => {
    mockUser = undefined;

    const res = await request(app).get('/api/v1/me/tenants');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
    expect(listTenantsForAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('GET /api/v1/me/tenants rejects users without recognized roles', async () => {
    mockUser = {
      sub: 'sub-norole',
      email: 'no-role@example.com',
      roles: [],
      rawClaims: {},
    } as express.Request['user'];

    const res = await request(app).get('/api/v1/me/tenants');

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'No recognized application role was found for this account' });
    expect(listTenantsForAuthenticatedUser).not.toHaveBeenCalled();
  });
});
