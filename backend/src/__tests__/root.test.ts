import express from 'express';
import request from 'supertest';

const authenticateMock = jest.fn((req, _res, next) => {
  req.user = {
    sub: 'root-subject',
    email: 'root@example.com',
    name: 'Root User',
    roles: ['ADMIN'],
    rawClaims: {},
  };
  next();
});

const getRootSessionMock = jest.fn();
const listTenantsForRootMock = jest.fn();
const getRootAccessProfileByEmailMock = jest.fn();
const upsertRootAccessProfileMock = jest.fn();

jest.mock('../middleware/auth', () => ({
  __esModule: true,
  default: (req: unknown, res: unknown, next: () => void) => authenticateMock(req, res, next),
}));

jest.mock('../middleware/requireRoot', () => ({
  __esModule: true,
  requireRoot: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../services/rootAccessService', () => ({
  __esModule: true,
  getRootSession: (...args: unknown[]) => getRootSessionMock(...args),
  listTenantsForRoot: (...args: unknown[]) => listTenantsForRootMock(...args),
  getRootAccessProfileByEmail: (...args: unknown[]) => getRootAccessProfileByEmailMock(...args),
  upsertRootAccessProfile: (...args: unknown[]) => upsertRootAccessProfileMock(...args),
}));

import rootRouter from '../routes/root';

const app = express();
app.use(express.json());
app.use('/api/v1/root', rootRouter);

describe('root routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /api/v1/root/session returns root session', async () => {
    getRootSessionMock.mockResolvedValue({
      user_id: 'user-id',
      email: 'root@example.com',
      display_name: 'Root',
      role: 'superadmin',
      is_root: true,
      root_role: 'root_admin',
    });

    const res = await request(app).get('/api/v1/root/session');

    expect(res.status).toBe(200);
    expect(res.body.email).toBe('root@example.com');
  });

  it('GET /api/v1/root/access validates email input', async () => {
    const res = await request(app).get('/api/v1/root/access');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('email');
  });

  it('PUT /api/v1/root/access validates app role', async () => {
    const res = await request(app)
      .put('/api/v1/root/access')
      .send({
        email: 'sarnitro@gmail.com',
        app_role: 'invalid',
        is_root: true,
        tenant_memberships: [],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('app_role');
  });

  it('PUT /api/v1/root/access validates root_role', async () => {
    const res = await request(app)
      .put('/api/v1/root/access')
      .send({
        email: 'sarnitro@gmail.com',
        app_role: 'superadmin',
        is_root: true,
        root_role: 'invalid_root',
        tenant_memberships: [],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('root_role');
  });

  it('PUT /api/v1/root/access validates tenant membership kind', async () => {
    const res = await request(app)
      .put('/api/v1/root/access')
      .send({
        email: 'sarnitro@gmail.com',
        app_role: 'superadmin',
        is_root: true,
        root_role: 'root_admin',
        tenant_memberships: [
          {
            tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
            role: 'admin',
            membership_kind: 'invalid_kind',
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('membership_kind');
  });

  it('PUT /api/v1/root/access forwards valid payload to service', async () => {
    upsertRootAccessProfileMock.mockResolvedValue({
      email: 'sarnitro@gmail.com',
      user: {
        user_id: 'u1',
        email: 'sarnitro@gmail.com',
        display_name: 'JB',
        role: 'superadmin',
        is_active: true,
        is_root: true,
        root_role: 'root_admin',
      },
      member: null,
      tenant_memberships: [],
      personas: [],
      groups: [],
    });

    const res = await request(app)
      .put('/api/v1/root/access')
      .send({
        email: 'sarnitro@gmail.com',
        app_role: 'superadmin',
        is_root: true,
        root_role: 'root_admin',
        ensure_member: true,
        personas: ['participant', 'volunteer'],
        tenant_memberships: [
          {
            tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
            role: 'admin',
            membership_kind: 'home',
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(upsertRootAccessProfileMock).toHaveBeenCalled();
  });
});
