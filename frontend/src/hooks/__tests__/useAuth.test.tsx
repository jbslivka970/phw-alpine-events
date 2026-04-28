import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../useAuth'

const mockSetTokenGetter = vi.fn()
const mockSetEmailHint = vi.fn()
const mockMembersMe = vi.fn()

vi.mock('../../api/client', () => ({
  setTokenGetter: (...args: unknown[]) => mockSetTokenGetter(...args),
  setEmailHint: (...args: unknown[]) => mockSetEmailHint(...args),
}))

vi.mock('../../api/members', () => ({
  membersApi: {
    me: (...args: unknown[]) => mockMembersMe(...args),
  },
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
    mockMembersMe.mockResolvedValue({ auth_roles: [] })
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

    expect(msalInstance.acquireTokenPopup).toHaveBeenCalledTimes(1)
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

    expect(msalInstance.acquireTokenPopup).toHaveBeenCalledTimes(1)
    expect(token).toBe('popup-token')
  })

  it('merges backend-resolved roles from members/me', async () => {
    mockMembersMe.mockResolvedValue({ auth_roles: ['ADMIN'] })

    const { result } = renderHook(() => useAuth())

    await waitFor(() => {
      expect(result.current.isAdmin()).toBe(true)
    })
  })
})
