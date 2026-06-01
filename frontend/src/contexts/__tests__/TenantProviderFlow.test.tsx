import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserTenantContext } from '../../api/me'
import { TenantProvider, useTenantContext } from '../TenantContext'

const listTenantsMock = vi.fn<() => Promise<UserTenantContext[]>>()
const useAuthMock = vi.fn()

vi.mock('../../api/me', () => ({
  meApi: {
    listTenants: () => listTenantsMock(),
  },
}))

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => useAuthMock(),
}))

function TestHarness() {
  const { loading, needsSelection, noAccess, activeTenant, tenants } = useTenantContext()

  return (
    <div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="needsSelection">{String(needsSelection)}</div>
      <div data-testid="noAccess">{String(noAccess)}</div>
      <div data-testid="activeTenant">{activeTenant?.tenant_id ?? ''}</div>
      <div data-testid="tenantCount">{tenants.length}</div>
    </div>
  )
}

function makeTenant(overrides: Partial<UserTenantContext>): UserTenantContext {
  return {
    tenant_id: '11111111-1111-4111-8111-111111111111',
    slug: 'colorado-alpine',
    display_name: 'Colorado Alpine',
    tenant_type: 'program',
    is_demo: false,
    role: 'member',
    membership_kind: 'home',
    expires_at: null,
    branding: null,
    ...overrides,
  }
}

describe('TenantProvider flow', () => {
  beforeEach(() => {
    useAuthMock.mockReturnValue({ isAuthenticated: true, rolesReady: true })
    listTenantsMock.mockReset()
    window.localStorage.clear()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('reuses persisted tenant selection after provider remount', async () => {
    const home = makeTenant({ tenant_id: '11111111-1111-4111-8111-111111111111' })
    const demo = makeTenant({
      tenant_id: '22222222-2222-4222-8222-222222222222',
      slug: 'demo',
      display_name: 'Demo',
      is_demo: true,
      membership_kind: 'temporary_demo',
    })

    listTenantsMock.mockResolvedValue([home, demo])
    window.localStorage.setItem('phw_active_tenant_id', demo.tenant_id)

    const first = render(
      <TenantProvider>
        <TestHarness />
      </TenantProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false')
    })

    expect(screen.getByTestId('activeTenant').textContent).toBe(demo.tenant_id)
    expect(screen.getByTestId('needsSelection').textContent).toBe('false')

    first.unmount()

    const second = render(
      <TenantProvider>
        <TestHarness />
      </TenantProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false')
    })

    expect(screen.getByTestId('activeTenant').textContent).toBe(demo.tenant_id)
    expect(screen.getByTestId('needsSelection').textContent).toBe('false')

    second.unmount()
  })

  it('requires selection when user has multiple tenants and no persisted selection', async () => {
    const home = makeTenant({ tenant_id: '11111111-1111-4111-8111-111111111111' })
    const demo = makeTenant({
      tenant_id: '22222222-2222-4222-8222-222222222222',
      slug: 'demo',
      display_name: 'Demo',
      is_demo: true,
      membership_kind: 'temporary_demo',
    })

    listTenantsMock.mockResolvedValue([home, demo])

    render(
      <TenantProvider>
        <TestHarness />
      </TenantProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false')
    })

    expect(screen.getByTestId('needsSelection').textContent).toBe('true')
    expect(screen.getByTestId('activeTenant').textContent).toBe(home.tenant_id)
    expect(screen.getByTestId('tenantCount').textContent).toBe('2')
  })
})
