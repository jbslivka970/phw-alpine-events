import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UserTenantContext } from '../../api/me'
import { TenantProvider, useTenantContext } from '../TenantContext'

const listTenantsMock = vi.fn<(signal?: AbortSignal) => Promise<UserTenantContext[]>>()
const useAuthMock = vi.fn()

vi.mock('../../api/me', () => ({
  meApi: {
    listTenants: (signal?: AbortSignal) => listTenantsMock(signal),
  },
}))

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => useAuthMock(),
}))

function TestHarness() {
  const { loading, loadError, needsSelection, noAccess, activeTenant, tenants, selectTenant } = useTenantContext()

  return (
    <div>
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="loadError">{loadError ?? ''}</div>
      <div data-testid="needsSelection">{String(needsSelection)}</div>
      <div data-testid="noAccess">{String(noAccess)}</div>
      <div data-testid="activeTenant">{activeTenant?.tenant_id ?? ''}</div>
      <div data-testid="tenantCount">{tenants.length}</div>
      <button onClick={() => tenants[1] && selectTenant(tenants[1].tenant_id)}>Select second</button>
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
    useAuthMock.mockReturnValue({
      isAuthenticated: true,
      rolesReady: true,
      user: { id: 'account-a', email: 'account-a@example.org' },
    })
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
    window.localStorage.setItem('phw_active_tenant_id:account-a', demo.tenant_id)

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

  it('stores selection under the current identity and removes the legacy global key', async () => {
    const home = makeTenant({ tenant_id: '11111111-1111-4111-8111-111111111111' })
    const demo = makeTenant({
      tenant_id: '22222222-2222-4222-8222-222222222222',
      membership_kind: 'temporary_demo',
    })
    listTenantsMock.mockResolvedValue([home, demo])
    window.localStorage.setItem('phw_active_tenant_id', demo.tenant_id)

    render(<TenantProvider><TestHarness /></TenantProvider>)
    await waitFor(() => expect(screen.getByTestId('tenantCount').textContent).toBe('2'))
    fireEvent.click(screen.getByRole('button', { name: 'Select second' }))

    expect(window.localStorage.getItem('phw_active_tenant_id')).toBeNull()
    expect(window.localStorage.getItem('phw_active_tenant_id:account-a')).toBe(demo.tenant_id)
  })

  it('ignores a delayed tenant response from the prior identity', async () => {
    const accountATenant = makeTenant({ tenant_id: '11111111-1111-4111-8111-111111111111' })
    const accountBTenant = makeTenant({ tenant_id: '22222222-2222-4222-8222-222222222222' })
    let resolveAccountA: ((tenants: UserTenantContext[]) => void) | undefined
    listTenantsMock
      .mockImplementationOnce(() => new Promise((resolve) => { resolveAccountA = resolve }))
      .mockResolvedValueOnce([accountBTenant])

    const view = render(<TenantProvider><TestHarness /></TenantProvider>)
    await waitFor(() => expect(listTenantsMock).toHaveBeenCalledTimes(1))

    useAuthMock.mockReturnValue({
      isAuthenticated: true,
      rolesReady: true,
      user: { id: 'account-b', email: 'account-b@example.org' },
    })
    view.rerender(<TenantProvider><TestHarness /></TenantProvider>)
    await waitFor(() => expect(screen.getByTestId('activeTenant').textContent).toBe(accountBTenant.tenant_id))

    resolveAccountA?.([accountATenant])
    await Promise.resolve()
    expect(screen.getByTestId('activeTenant').textContent).toBe(accountBTenant.tenant_id)
  })

  it('reports an expired session instead of no tenant access after a 401', async () => {
    listTenantsMock.mockRejectedValue(new Error('API 401: Unauthorized'))

    render(
      <TenantProvider>
        <TestHarness />
      </TenantProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('loadError').textContent).toBe('session_expired')
    })

    expect(screen.getByTestId('noAccess').textContent).toBe('false')
  })

  it('reports temporary tenant API failures without discarding the current tenant', async () => {
    const home = makeTenant({})
    listTenantsMock.mockResolvedValueOnce([home]).mockRejectedValueOnce(new Error('API 503: Unavailable'))

    const { rerender } = render(
      <TenantProvider>
        <TestHarness />
      </TenantProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('activeTenant').textContent).toBe(home.tenant_id)
    })

    useAuthMock.mockReturnValue({ isAuthenticated: false, rolesReady: true, user: null })
    rerender(<TenantProvider><TestHarness /></TenantProvider>)
    useAuthMock.mockReturnValue({
      isAuthenticated: true,
      rolesReady: true,
      user: { id: 'account-a', email: 'account-a@example.org' },
    })
    rerender(<TenantProvider><TestHarness /></TenantProvider>)

    await waitFor(() => {
      expect(screen.getByTestId('loadError').textContent).toBe('unavailable')
    })

    expect(screen.getByTestId('noAccess').textContent).toBe('false')
  })
})
