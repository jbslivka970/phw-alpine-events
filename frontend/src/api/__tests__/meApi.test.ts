import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGetWithoutTenant } from '../client';
import { meApi } from '../me';

vi.mock('../client', () => ({
  apiGetWithoutTenant: vi.fn(),
}));

const mockedApiGetWithoutTenant = apiGetWithoutTenant as unknown as ReturnType<typeof vi.fn>;

describe('meApi contract', () => {
  beforeEach(() => {
    mockedApiGetWithoutTenant.mockReset();
  });

  it('unwraps the backend /me/tenants response envelope', async () => {
    const tenant = {
      tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
      slug: 'colorado-alpine',
      display_name: 'Colorado Alpine',
      tenant_type: 'program',
      is_demo: false,
      role: 'member',
      membership_kind: 'home',
      expires_at: null,
      branding: null,
    };

    mockedApiGetWithoutTenant.mockResolvedValue({ tenants: [tenant] });

    await expect(meApi.listTenants()).resolves.toEqual([tenant]);
    expect(mockedApiGetWithoutTenant).toHaveBeenCalledWith('/me/tenants');
  });
});
