import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTenantContext } from '../../contexts/TenantContext'
import { useAuth } from '../../hooks/useAuth'
import { LoginPage } from '../LoginPage'

const mockNavigate = vi.fn()

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  }
})

vi.mock('../../hooks/useAuth', () => ({
  useAuth: vi.fn(),
}))

vi.mock('../../contexts/TenantContext', () => ({
  useTenantContext: vi.fn(),
}))

const mockedUseAuth = useAuth as unknown as ReturnType<typeof vi.fn>
const mockedUseTenantContext = useTenantContext as unknown as ReturnType<typeof vi.fn>

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <LoginPage />
    </MemoryRouter>
  )
}

describe('LoginPage tenant redirect behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedUseAuth.mockReturnValue({
      login: vi.fn(),
      isLoggingIn: false,
      loginError: null,
      isAuthenticated: false,
    })
    mockedUseTenantContext.mockReturnValue({
      loading: false,
      needsSelection: false,
      noAccess: false,
      activeTenant: null,
    })
  })

  it('navigates authenticated users to tenant selection when selection is required', async () => {
    mockedUseAuth.mockReturnValue({
      login: vi.fn(),
      isLoggingIn: false,
      loginError: null,
      isAuthenticated: true,
    })
    mockedUseTenantContext.mockReturnValue({
      loading: false,
      needsSelection: true,
      noAccess: false,
      activeTenant: null,
    })

    renderPage()

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/tenant/select', { replace: true })
    })
  })

  it('navigates authenticated users with no memberships to tenant selection', async () => {
    mockedUseAuth.mockReturnValue({
      login: vi.fn(),
      isLoggingIn: false,
      loginError: null,
      isAuthenticated: true,
    })
    mockedUseTenantContext.mockReturnValue({
      loading: false,
      needsSelection: false,
      noAccess: true,
      activeTenant: null,
    })

    renderPage()

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/tenant/select', { replace: true })
    })
  })

  it('navigates authenticated users to dashboard when tenant context is ready', async () => {
    mockedUseAuth.mockReturnValue({
      login: vi.fn(),
      isLoggingIn: false,
      loginError: null,
      isAuthenticated: true,
    })
    mockedUseTenantContext.mockReturnValue({
      loading: false,
      needsSelection: false,
      noAccess: false,
      activeTenant: {
        tenant_id: '11111111-1111-4111-8111-111111111111',
        display_name: 'Colorado Alpine Program',
        slug: 'phw-alpine-demo',
        membership_kind: 'home',
        starts_at: null,
        expires_at: null,
        branding: null,
      },
    })

    renderPage()

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/dashboard', { replace: true })
    })
  })
})
