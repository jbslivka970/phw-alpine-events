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
const getTenantBrandingMock = jest.fn();
const upsertTenantBrandingMock = jest.fn();
const createBrandingAssetUploadUrlMock = jest.fn();
const commitBrandingAssetMock = jest.fn();

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

jest.mock('../services/rootTenantBrandingService', () => ({
  __esModule: true,
  getTenantBranding: (...args: unknown[]) => getTenantBrandingMock(...args),
  upsertTenantBranding: (...args: unknown[]) => upsertTenantBrandingMock(...args),
  createBrandingAssetUploadUrl: (...args: unknown[]) => createBrandingAssetUploadUrlMock(...args),
  commitBrandingAsset: (...args: unknown[]) => commitBrandingAssetMock(...args),
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

  it('GET /api/v1/root/tenants/:tenantId/branding validates tenant id', async () => {
    const res = await request(app).get('/api/v1/root/tenants/not-a-guid/branding');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('tenantId');
  });

  it('GET /api/v1/root/tenants/:tenantId/branding returns branding payload', async () => {
    getTenantBrandingMock.mockResolvedValue({
      tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
      org_long_name: 'PHW Colorado Alpine',
      org_short_name: 'PHW Alpine',
      support_email: null,
      accessibility_email: null,
      logo_url: null,
      logo_dark_url: null,
      hero_image_urls: [],
      primary_color: null,
      accent_color: null,
      dark_color: null,
      program_tagline: null,
      portal_login_url: null,
      mission_blurb: null,
      created_at: '2026-06-02T00:00:00.000Z',
      updated_at: '2026-06-02T00:00:00.000Z',
    });

    const res = await request(app).get('/api/v1/root/tenants/1b6b9719-663a-4e56-8f7d-9a4bd4c10001/branding');
    expect(res.status).toBe(200);
    expect(res.body.org_short_name).toBe('PHW Alpine');
  });

  it('POST /api/v1/root/tenants/:tenantId/branding/assets/upload-url validates asset kind', async () => {
    const res = await request(app)
      .post('/api/v1/root/tenants/1b6b9719-663a-4e56-8f7d-9a4bd4c10001/branding/assets/upload-url')
      .send({
        file_name: 'logo.png',
        content_type: 'image/png',
        asset_kind: 'bad_kind',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('asset_kind');
  });

  it('POST /api/v1/root/tenants/:tenantId/branding/assets/upload-url forwards valid payload', async () => {
    createBrandingAssetUploadUrlMock.mockResolvedValue({
      upload_url: 'https://example.blob.core.windows.net/tenant-branding/file.png?sig=abc',
      blob_url: 'https://example.blob.core.windows.net/tenant-branding/file.png',
      blob_path: 'colorado-alpine/logo/file.png',
      expires_at: '2026-06-02T00:15:00.000Z',
      required_headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': 'image/png' },
    });

    const res = await request(app)
      .post('/api/v1/root/tenants/1b6b9719-663a-4e56-8f7d-9a4bd4c10001/branding/assets/upload-url')
      .send({
        file_name: 'logo.png',
        content_type: 'image/png',
        asset_kind: 'logo',
      });

    expect(res.status).toBe(200);
    expect(createBrandingAssetUploadUrlMock).toHaveBeenCalledWith({
      tenantId: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
      fileName: 'logo.png',
      contentType: 'image/png',
      assetKind: 'logo',
    });
  });

  it('POST /api/v1/root/tenants/:tenantId/branding/assets/commit requires asset_url', async () => {
    const res = await request(app)
      .post('/api/v1/root/tenants/1b6b9719-663a-4e56-8f7d-9a4bd4c10001/branding/assets/commit')
      .send({ asset_kind: 'logo' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('asset_url');
  });

  it('POST /api/v1/root/tenants/:tenantId/branding/assets/commit forwards valid payload', async () => {
    commitBrandingAssetMock.mockResolvedValue({ tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001' });

    const res = await request(app)
      .post('/api/v1/root/tenants/1b6b9719-663a-4e56-8f7d-9a4bd4c10001/branding/assets/commit')
      .send({
        asset_kind: 'logo_dark',
        asset_url: 'https://example.blob.core.windows.net/tenant-branding/colorado-alpine/logo/file.png',
      });

    expect(res.status).toBe(200);
    expect(commitBrandingAssetMock).toHaveBeenCalledWith({
      tenantId: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
      assetKind: 'logo_dark',
      assetUrl: 'https://example.blob.core.windows.net/tenant-branding/colorado-alpine/logo/file.png',
    });
  });
});
