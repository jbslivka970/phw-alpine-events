import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../useAuth'

const mockSetTokenGetter = vi.fn()
const mockSetEmailHint = vi.fn()
const mockSetMemberInviteToken = vi.fn()
const mockFetch = vi.fn()

vi.mock('../../api/client', () => ({
  setTokenGetter: (...args: unknown[]) => mockSetTokenGetter(...args),
  setEmailHint: (...args: unknown[]) => mockSetEmailHint(...args),
  setMemberInviteToken: (...args: unknown[]) => mockSetMemberInviteToken(...args),
}))

vi.mock('../../authConfig', () => ({
  hasAuthConfig: true,
  loginRequest: { scopes: ['openid', 'profile', 'email'] },
  popupRedirectUri: undefined,
  preferPopupOnSafari: true,
  ROLES: {
    ADMIN: 'ADMIN',
    EVENT_CREATOR: 'EVENT_CREATOR',
    USER: 'USER',
    TAVF_CREATOR: 'TAVF_CREATOR',
  },
}))

const mockUseMsal = vi.fn()
const mockUseIsAuthenticated = vi.fn()

vi.mock('@azure/msal-react', () => ({
  useMsal: () => mockUseMsal(),
  useIsAuthenticated: () => mockUseIsAuthenticated(),
}))

describe('useAuth auth flow regression coverage', () => {
  const account = {
    localAccountId: 'local-1',
    username: 'member@example.org',
    name: 'Member User',
    idTokenClaims: {
      sub: 'subject-1',
      roles: ['ADMIN'],
    },
  }

  const msalInstance = {
    loginPopup: vi.fn(),
    logoutPopup: vi.fn(),
    acquireTokenSilent: vi.fn(),
    acquireTokenPopup: vi.fn(),
    setActiveAccount: vi.fn(),
    getActiveAccount: vi.fn(),
    getAllAccounts: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    window.localStorage.clear()
    vi.stubGlobal('fetch', mockFetch as unknown as typeof fetch)

    mockUseMsal.mockReturnValue({
      accounts: [account],
      instance: msalInstance,
      inProgress: 'none',
    })
    mockUseIsAuthenticated.mockReturnValue(true)

    msalInstance.loginPopup.mockResolvedValue({})
    msalInstance.logoutPopup.mockResolvedValue({})
    msalInstance.acquireTokenSilent.mockResolvedValue({
      accessToken: 'silent-token',
      idTokenClaims: account.idTokenClaims,
    })
    msalInstance.acquireTokenPopup.mockResolvedValue({ accessToken: 'popup-token' })
    msalInstance.getActiveAccount.mockReturnValue(null)
    msalInstance.getAllAccounts.mockReturnValue([account])
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ auth_roles: [] }),
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    window.localStorage.clear()
  })

  it('uses popup sign-in flow when login is requested', async () => {
    const { result } = renderHook(() => useAuth())

    await act(async () => {
      await result.current.login()
    })

    expect(msalInstance.loginPopup).toHaveBeenCalledTimes(1)
    expect(msalInstance.loginPopup).toHaveBeenCalledWith(expect.objectContaining({ scopes: expect.any(Array) }))
  })

  it('shows popup blocked guidance when login popup fails', async () => {
    msalInstance.loginPopup.mockRejectedValueOnce({ errorCode: 'popup_window_error' })

    const { result } = renderHook(() => useAuth())

    await act(async () => {
      await result.current.login()
    })

    expect(result.current.loginError).toMatch(/blocked the sign-in (window|popup)/i)
  })

  it('logs out via popup and keeps redirect in the main window', async () => {
    const { result } = renderHook(() => useAuth())

    await act(async () => {
      await result.current.logout()
    })

    expect(msalInstance.logoutPopup).toHaveBeenCalledTimes(1)
    expect(mockSetMemberInviteToken).toHaveBeenCalledWith(null)
    expect(msalInstance.logoutPopup).toHaveBeenCalledWith(
      expect.objectContaining({
        account,
        postLogoutRedirectUri: null,
        mainWindowRedirectUri: `${window.location.origin}/login`,
      }),
    )
  })

  it('registers token getter and falls back to popup token acquisition on interaction-required', async () => {
    msalInstance.acquireTokenSilent.mockRejectedValue({ errorCode: 'interaction_required' })

    renderHook(() => useAuth())

    await waitFor(() => {
      expect(mockSetTokenGetter).toHaveBeenCalled()
    })

    const getter = mockSetTokenGetter.mock.calls.at(-1)?.[0] as (() => Promise<string | null>)
    const token = await getter()

    expect(msalInstance.acquireTokenPopup).toHaveBeenCalled()
    expect(token).toBe('popup-token')
  })

  it('treats timed_out silent token failures as interactive fallback', async () => {
    msalInstance.acquireTokenSilent.mockRejectedValue({ errorCode: 'timed_out' })

    renderHook(() => useAuth())

    await waitFor(() => {
      expect(mockSetTokenGetter).toHaveBeenCalled()
    })

    const getter = mockSetTokenGetter.mock.calls.at(-1)?.[0] as (() => Promise<string | null>)
    const token = await getter()

    expect(msalInstance.acquireTokenPopup).toHaveBeenCalled()
    expect(token).toBe('popup-token')
  })

  it('treats browser pattern silent token failures as interactive fallback and still hydrates backend roles', async () => {
    msalInstance.acquireTokenSilent.mockRejectedValue(new Error('The string did not match the expected pattern.'))
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ auth_roles: ['ADMIN'] }),
    })

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(result.current.isAdmin()).toBe(true)
    })

    expect(msalInstance.acquireTokenPopup).toHaveBeenCalledTimes(1)
  })

  it('merges backend-resolved roles from members/me', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ auth_roles: ['ADMIN'] }),
    })

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(result.current.isAdmin()).toBe(true)
    })
  })

  it('normalizes EXT-format account usernames before sending X-Id-Token-Email', async () => {
    mockUseMsal.mockReturnValue({
      accounts: [{
        ...account,
        username: 'SARNITRO_gmail.com#EXT#@tenant.onmicrosoft.com',
        idTokenClaims: {
          sub: 'subject-1',
        },
      }],
      instance: msalInstance,
      inProgress: 'none',
    })

    renderHook(() => useAuth())

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })

    const requestInit = mockFetch.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined
    expect(requestInit?.headers?.['X-Id-Token-Email']).toBe('sarnitro@gmail.com')
  })

  it('prefers nonstandard email claim keys over synthetic tenant usernames for X-Id-Token-Email', async () => {
    mockUseMsal.mockReturnValue({
      accounts: [{
        ...account,
        username: 'c7c703e4-8ee5-46fa-a6c0-fbb7d48dee88@PHWAlpine.onmicrosoft.com',
        idTokenClaims: {
          sub: 'subject-1',
          'signInNames.emailAddress': 'sarnitro@gmail.com',
        },
      }],
      instance: msalInstance,
      inProgress: 'none',
    })

    renderHook(() => useAuth())

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })

    const requestInit = mockFetch.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined
    expect(requestInit?.headers?.['X-Id-Token-Email']).toBe('sarnitro@gmail.com')
  })

  it('omits synthetic tenant usernames from X-Id-Token-Email when no real email is available', async () => {
    mockUseMsal.mockReturnValue({
      accounts: [{
        ...account,
        username: 'c7c703e4-8ee5-46fa-a6c0-fbb7d48dee88@PHWAlpine.onmicrosoft.com',
        idTokenClaims: {
          sub: 'subject-1',
        },
      }],
      instance: msalInstance,
      inProgress: 'none',
    })

    renderHook(() => useAuth())

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalled()
    })

    const requestInit = mockFetch.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined
    expect(requestInit?.headers?.['X-Id-Token-Email']).toBeUndefined()
  })

  it('uses seeded external E2E token and email hint for browser auth state', async () => {
    vi.stubEnv('VITE_E2E_EXTERNAL_AUTH', '1')
    window.localStorage.setItem('phw_e2e_external_auth', '1')
    window.localStorage.setItem('phw_e2e_external_token', 'external-token')
    window.localStorage.setItem('phw_e2e_external_email', 'member@example.org')
    window.localStorage.setItem('phw_e2e_external_user_id', 'member-1')
    window.localStorage.setItem('phw_e2e_role', 'USER')

    mockUseMsal.mockReturnValue({
      accounts: [],
      instance: msalInstance,
      inProgress: 'none',
    })
    mockUseIsAuthenticated.mockReturnValue(false)

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(mockSetTokenGetter).toHaveBeenCalled()
      expect(mockSetEmailHint).toHaveBeenCalledWith('member@example.org')
    })

    const getter = mockSetTokenGetter.mock.calls.at(-1)?.[0] as (() => Promise<string | null>)
    await expect(getter()).resolves.toBe('external-token')
    expect(result.current.isAuthenticated).toBe(true)
    expect(result.current.user?.email).toBe('member@example.org')
  })

  it('shares backend-resolved roles across separate useAuth hook instances', async () => {
    const first = renderHook(() => useAuth())
    const second = renderHook(() => useAuth())

    await waitFor(() => {
      expect(first.result.current.isAdmin()).toBe(true)
      expect(second.result.current.isAdmin()).toBe(true)
    })
  })
})
