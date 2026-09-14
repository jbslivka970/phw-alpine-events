import { useEffect } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTenantContext } from '../contexts/TenantContext';
import { useAuth } from '../hooks/useAuth';
import Layout from './Layout';

vi.mock('../contexts/TenantContext', () => ({
  useTenantContext: vi.fn(),
  activeRoleHasAppRole: (activeRole: string | null, requiredRole: string) => {
    if (activeRole === 'admin') return true;
    if (activeRole === 'event_creator') return requiredRole !== 'ADMIN';
    if (activeRole === 'tavf_creator') return requiredRole === 'TAVF_CREATOR' || requiredRole === 'USER';
    return requiredRole === 'USER';
  },
}));

vi.mock('../hooks/useAuth', () => ({
  useAuth: vi.fn(),
}));

const mockedUseTenantContext = useTenantContext as unknown as ReturnType<typeof vi.fn>;
const mockedUseAuth = useAuth as unknown as ReturnType<typeof vi.fn>;

const coloradoAlpine = {
  tenant_id: '1b6b9719-663a-4e56-8f7d-9a4bd4c10001',
  slug: 'colorado-alpine',
  display_name: 'Colorado Alpine',
  tenant_type: 'program',
  is_demo: false,
  role: 'admin',
  membership_kind: 'home',
  expires_at: null,
  branding: { org_short_name: 'Colorado Alpine', primary_color: '#1f5f4a', logo_url: null },
};

const coloradoSprings = {
  ...coloradoAlpine,
  tenant_id: '527d755c-6818-40a0-bd7f-137a91b9e54e',
  slug: 'colorado-springs',
  display_name: 'Colorado Springs',
  membership_kind: 'admin',
  branding: { org_short_name: 'Colorado Springs', primary_color: '#b45309', logo_url: null },
};

function RoutedPage({ onMount }: { onMount: () => void }) {
  useEffect(() => {
    onMount();
  }, [onMount]);
  return <h1>Tenant page</h1>;
}

function renderLayout(onMount: () => void, initialEntry = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/dashboard" element={<RoutedPage onMount={onMount} />} />
          <Route path="/events/:eventId" element={<h1>Event detail</h1>} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Layout tenant context', () => {
  beforeEach(() => {
    mockedUseAuth.mockReturnValue({
      user: { name: 'Program Admin', email: 'admin@example.org', roles: ['ADMIN'] },
      logout: vi.fn(),
      canCreateTavfPostings: () => false,
    });
  });

  it('shows the current program and remounts routed content after a tenant switch', () => {
    const onMount = vi.fn();
    const selectTenant = vi.fn();
    mockedUseTenantContext.mockReturnValue({
      activeTenant: coloradoAlpine,
      activeRole: coloradoAlpine.role,
      tenants: [coloradoAlpine, coloradoSprings],
      selectTenant,
    });

    const view = renderLayout(onMount);

    expect(screen.getByRole('status')).toHaveTextContent(/Current program\s*Colorado Alpine/);
    expect(screen.getByLabelText('Current program')).toHaveValue(coloradoAlpine.tenant_id);
    expect(onMount).toHaveBeenCalledTimes(1);

    mockedUseTenantContext.mockReturnValue({
      activeTenant: coloradoSprings,
      activeRole: coloradoSprings.role,
      tenants: [coloradoAlpine, coloradoSprings],
      selectTenant,
    });
    view.rerender(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/dashboard" element={<RoutedPage onMount={onMount} />} />
          </Route>
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByRole('status')).toHaveTextContent(/Current program\s*Colorado Springs/);
    expect(onMount).toHaveBeenCalledTimes(2);
  });

  it('switches the tenant and leaves a tenant-specific resource route', () => {
    const selectTenant = vi.fn();
    mockedUseTenantContext.mockReturnValue({
      activeTenant: coloradoAlpine,
      activeRole: coloradoAlpine.role,
      tenants: [coloradoAlpine, coloradoSprings],
      selectTenant,
    });

    renderLayout(vi.fn(), '/events/previous-tenant-event');
    fireEvent.change(screen.getByLabelText('Current program'), {
      target: { value: coloradoSprings.tenant_id },
    });

    expect(selectTenant).toHaveBeenCalledWith(coloradoSprings.tenant_id);
    expect(screen.getByRole('heading', { name: 'Tenant page' })).toBeInTheDocument();
  });

  it('hides management controls when the active tenant role is member despite a global admin role', () => {
    mockedUseTenantContext.mockReturnValue({
      activeTenant: { ...coloradoAlpine, role: 'member' },
      activeRole: 'member',
      tenants: [{ ...coloradoAlpine, role: 'member' }],
      selectTenant: vi.fn(),
    });

    renderLayout(vi.fn());

    expect(screen.queryByRole('button', { name: 'Manage' })).not.toBeInTheDocument();
  });
});