import { useEffect, useRef, useState } from 'react'
import { useIsAuthenticated, useMsal } from '@azure/msal-react'
import { InteractionStatus } from '@azure/msal-browser'
import { hasAuthConfig, loginRequest, popupRedirectUri, ROLES } from '../authConfig'
import type { AppRole } from '../authConfig'
import { setTokenGetter } from '../api/client'
import { authDebugLog, authDebugWarn } from '../utils/authDebug'

const LOGIN_POPUP_TIMEOUT_MS = 90_000
const TOKEN_EXPIRY_SAFETY_WINDOW_MS = 60_000

interface CachedAccessToken {
  token: string
  expiresAtMs: number
}

interface AuthUser {
  id: string
  name: string
  email: string
  roles: AppRole[]
}

function useAuth() {
  const { accounts, instance, inProgress } = useMsal()
  const isAuthenticated = useIsAuthenticated()
  const account = accounts[0] ?? null
  const loginRequestRef = useRef<Promise<void> | null>(null)
  const tokenInteractiveInFlightRef = useRef(false)
  const tokenRequestInFlightRef = useRef<Promise<string | null> | null>(null)
  const tokenCacheRef = useRef<CachedAccessToken | null>(null)

  const accountClaims = account?.idTokenClaims as Record<string, unknown> | undefined
  const [resolvedRoles, setResolvedRoles] = useState<AppRole[]>(() => mapRoles(accountClaims))
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)

  useEffect(() => {
    setResolvedRoles(mapRoles(accountClaims))
  }, [accountClaims])

  useEffect(() => {
    if (account) {
      instance.setActiveAccount(account)
    }
  }, [account, instance])

  useEffect(() => {
    tokenCacheRef.current = null
    tokenRequestInFlightRef.current = null
  }, [account?.localAccountId])

  useEffect(() => {
    let cancelled = false

    async function refreshClaims() {
      if (!account) {
        if (!cancelled) {
          setResolvedRoles([])
        }
        return
      }

      try {
        const tokenResponse = await instance.acquireTokenSilent({
          ...loginRequest,
          account,
          forceRefresh: true,
        })

        if (!cancelled) {
          const refreshedClaims = tokenResponse.idTokenClaims as Record<string, unknown> | undefined
          setResolvedRoles(mapRoles(refreshedClaims))
        }
      } catch {
        // Keep previously derived roles if forced refresh is unavailable.
      }
    }

    void refreshClaims()

    return () => {
      cancelled = true
    }
  }, [account, instance])

  const subjectClaim = typeof account?.idTokenClaims?.sub === 'string'
    ? account.idTokenClaims.sub
    : null

  const user: AuthUser | null = account
    ? {
        id: subjectClaim ?? account.localAccountId,
        name: account.name ?? account.username ?? 'User',
        email: account.username,
        roles: resolvedRoles,
      }
    : null

  function hasRole(role: AppRole): boolean {
    return user?.roles.includes(role) ?? false
  }

  function isAdmin(): boolean {
    return hasRole(ROLES.ADMIN)
  }

  function canCreateEvents(): boolean {
    return hasRole(ROLES.ADMIN) || hasRole(ROLES.EVENT_CREATOR)
  }

  function canCreateTavfPostings(): boolean {
    return Boolean(user) && !isAdmin()
  }

  const interactionBusy = inProgress !== InteractionStatus.None

  useEffect(() => {
    authDebugLog('useAuth:state', {
      isAuthenticated,
      inProgress,
      interactionBusy,
      accountCount: accounts.length,
      activeAccount: instance.getActiveAccount()?.username,
      isLoggingIn,
      hasLoginError: Boolean(loginError),
    })
  }, [accounts.length, inProgress, interactionBusy, isAuthenticated, isLoggingIn, loginError, instance])

  async function login() {
    authDebugLog('login:start', {
      hasAuthConfig,
      interactionBusy,
      hasExistingLoginRequest: Boolean(loginRequestRef.current),
    })

    if (!hasAuthConfig) {
      setLoginError('Sign-in is temporarily unavailable because Azure AD app settings are missing in this build. Please contact an administrator.')
      authDebugWarn('login:blocked:missing-auth-config')
      return
    }

    if (interactionBusy && !loginRequestRef.current) {
      setLoginError('Authentication is still finalizing from a previous attempt. Please try again in a moment.')
      authDebugWarn('login:blocked:interaction-busy')
      return
    }

    if (loginRequestRef.current) {
      authDebugWarn('login:reused-existing-request')
      return loginRequestRef.current
    }

    setLoginError(null)
    setIsLoggingIn(true)

    loginRequestRef.current = (async () => {
      try {
        setLoginError('Opening sign-in window...')
        authDebugLog('login:popup:open', {
          redirectUri: popupRedirectUri ?? window.location.origin,
        })
        const loginResult = await withTimeout(instance.loginPopup({
          ...loginRequest,
          redirectUri: popupRedirectUri ?? window.location.origin,
          prompt: 'select_account',
        }), LOGIN_POPUP_TIMEOUT_MS)
        authDebugLog('login:popup:resolved', {
          hasResultAccount: Boolean(loginResult?.account),
          activeAccount: instance.getActiveAccount()?.username,
          allAccounts: instance.getAllAccounts().map((item) => item.username),
        })
        const signedInAccount = loginResult?.account ?? instance.getActiveAccount() ?? instance.getAllAccounts()[0]

        if (!signedInAccount) {
          setLoginError('Sign-in did not complete. Please try again.')
          authDebugWarn('login:popup:no-account')
          return
        }

        instance.setActiveAccount(signedInAccount)
        authDebugLog('login:set-active-account', {
          username: signedInAccount.username,
        })
        setLoginError(null)
      } catch (error: unknown) {
        const code = (error as { errorCode?: string })?.errorCode
        const message = (error as { message?: string })?.message ?? ''
        authDebugWarn('login:popup:error', {
          code,
          message,
        })
        if (code === 'user_cancelled') {
          setLoginError('Sign-in was cancelled.')
          return
        }
        if (code === 'interaction_in_progress') {
          setLoginError('Another sign-in dialog is already in progress. Close it and try again.')
          return
        }
        if (code === 'popup_window_error' || code === 'popup_window_timeout' || message.toLowerCase().includes('popup')) {
          setLoginError('Your browser blocked the sign-in popup. Please allow popups for this site and try again.')
          return
        }
        setLoginError('Sign-in failed. Please try again.')
        if (code !== 'user_cancelled' && code !== 'interaction_in_progress') {
          console.error('[MSAL] Login error:', error)
        }
      }
    })()

    try {
      await loginRequestRef.current
      authDebugLog('login:complete', {
        activeAccount: instance.getActiveAccount()?.username,
        accountCount: instance.getAllAccounts().length,
      })
    } finally {
      loginRequestRef.current = null
      setIsLoggingIn(false)
      authDebugLog('login:finalize')
    }
  }

  async function logout() {
    await instance.logoutPopup({
      account: account ?? undefined,
      postLogoutRedirectUri: popupRedirectUri ?? null,
      mainWindowRedirectUri: `${window.location.origin}/login`,
    })
  }

  useEffect(() => {
    setTokenGetter(async () => {
      if (!account) return null

      const cached = tokenCacheRef.current
      if (cached && cached.expiresAtMs - Date.now() > TOKEN_EXPIRY_SAFETY_WINDOW_MS) {
        return cached.token
      }

      if (tokenRequestInFlightRef.current) {
        return tokenRequestInFlightRef.current
      }

      const tokenPromise = (async (): Promise<string | null> => {
        try {
          const tokenResponse = await instance.acquireTokenSilent({
            ...loginRequest,
            account,
          })
          authDebugLog('token:silent:success', {
            account: account.username,
            expiresOn: tokenResponse.expiresOn?.toISOString(),
          })

          if (tokenResponse.expiresOn) {
            tokenCacheRef.current = {
              token: tokenResponse.accessToken,
              expiresAtMs: tokenResponse.expiresOn.getTime(),
            }
          }

          return tokenResponse.accessToken
        } catch (error: unknown) {
          if (!isInteractionRequired(error)) {
            const code = (error as { errorCode?: string } | null)?.errorCode
            authDebugWarn('token:silent:non-interaction-error', {
              code,
              account: account.username,
            })
            if (code !== 'interaction_in_progress') {
              console.error('[MSAL] Silent token acquisition failed:', error)
            }
            return null
          }

          authDebugWarn('token:silent:interaction-required', {
            account: account.username,
            interactionBusy,
            hasLoginRequestInFlight: Boolean(loginRequestRef.current),
          })

          if (interactionBusy || loginRequestRef.current) {
            authDebugWarn('token:popup:skipped:interaction-busy')
            return null
          }

          if (!tokenInteractiveInFlightRef.current) {
            tokenInteractiveInFlightRef.current = true
            try {
              const tokenResponse = await instance.acquireTokenPopup({
                ...loginRequest,
                account,
                redirectUri: popupRedirectUri ?? window.location.origin,
              })
              authDebugLog('token:popup:success', {
                account: account.username,
                expiresOn: tokenResponse.expiresOn?.toISOString(),
              })

              if (tokenResponse.expiresOn) {
                tokenCacheRef.current = {
                  token: tokenResponse.accessToken,
                  expiresAtMs: tokenResponse.expiresOn.getTime(),
                }
              }

              tokenInteractiveInFlightRef.current = false
              return tokenResponse.accessToken
            } catch (redirectError: unknown) {
              const code = (redirectError as { errorCode?: string })?.errorCode
              const message = (redirectError as { message?: string })?.message ?? ''
              authDebugWarn('token:popup:error', {
                code,
                message,
              })
              if (code === 'popup_window_error' || code === 'popup_window_timeout' || message.toLowerCase().includes('popup')) {
                // Avoid full-page redirect fallback here to prevent auth bounce loops on browsers
                // that block popup/cookie access during background token refresh.
                setLoginError('Your browser blocked the sign-in popup. Please allow popups/cookies for this site and sign in again.')
                tokenInteractiveInFlightRef.current = false
                return null
              }

              if (code !== 'interaction_in_progress') {
                console.error('[MSAL] Popup token acquisition failed:', redirectError)
              }
              tokenInteractiveInFlightRef.current = false
            }
          }

          return null
        }
      })()

      tokenRequestInFlightRef.current = tokenPromise
      try {
        return await tokenPromise
      } finally {
        tokenRequestInFlightRef.current = null
      }
    })
  }, [account, instance, interactionBusy])

  return {
    hasRole,
    isAdmin,
    canCreateEvents,
    canCreateTavfPostings,
    isAuthenticated,
    login,
    logout,
    user,
    interactionBusy,
    isLoggingIn,
    loginError,
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      authDebugWarn('login:popup:timeout', { timeoutMs })
      reject(new Error('popup_window_timeout'))
    }, timeoutMs)
  })

  try {
    return await Promise.race([promise, timeoutPromise])
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  }
}

function isInteractionRequired(error: unknown): boolean {
  const code = (error as { errorCode?: string } | null)?.errorCode?.toLowerCase() ?? ''
  return code.includes('interaction_required')
    || code.includes('consent_required')
    || code.includes('login_required')
    || code.includes('no_tokens_found')
}

function extractRoleValues(claims: Record<string, unknown> | undefined): string[] {
  if (!claims) {
    return []
  }

  const keys = ['roles', 'role', 'extension_Roles', 'extension_roles', 'app_roles', 'appRoles']
  const values: string[] = []

  for (const key of keys) {
    const value = claims[key]
    if (typeof value === 'string') {
      values.push(value)
      continue
    }
    if (Array.isArray(value)) {
      for (const role of value) {
        if (typeof role === 'string') {
          values.push(role)
        }
      }
    }
  }

  return values
}

function mapRoles(claims: Record<string, unknown> | undefined): AppRole[] {
  const rawRoleValues = extractRoleValues(claims)
  return rawRoleValues
    .map(normalizeRole)
    .filter((role): role is AppRole => Boolean(role))
    .filter((role, index, all) => all.indexOf(role) === index)
}

function normalizeRole(value: string): AppRole | null {
  const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_')
  if (Object.values(ROLES).includes(normalized as AppRole)) {
    return normalized as AppRole
  }

  if (['ADMINISTRATOR', 'CHAPTER_ADMIN', 'SUPERADMIN', 'SUPER_ADMIN'].includes(normalized)) {
    return ROLES.ADMIN
  }

  if (['EVENTCREATOR', 'EVENT_MANAGER', 'EVENT_ADMIN'].includes(normalized)) {
    return ROLES.EVENT_CREATOR
  }

  if (['MEMBER', 'PARTICIPANT', 'READER'].includes(normalized)) {
    return ROLES.USER
  }

  return null
}

export { useAuth }