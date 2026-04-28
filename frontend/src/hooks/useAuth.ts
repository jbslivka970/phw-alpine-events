import { useCallback, useEffect, useRef, useState } from 'react'
import { useIsAuthenticated, useMsal } from '@azure/msal-react'
import { InteractionStatus } from '@azure/msal-browser'
import { hasAuthConfig, loginRequest, popupRedirectUri, ROLES } from '../authConfig'
import type { AppRole } from '../authConfig'
import { setEmailHint, setTokenGetter } from '../api/client'
import { authDebugLog, authDebugWarn } from '../utils/authDebug'

const LOGIN_POPUP_TIMEOUT_MS = 240_000
const LOGIN_ACCOUNT_RECOVERY_TIMEOUT_MS = 45_000
const LOGIN_ACCOUNT_RECOVERY_POLL_MS = 500
const TOKEN_EXPIRY_SAFETY_WINDOW_MS = 60_000
const TOKEN_BUSY_RETRY_MS = 400
const TOKEN_BUSY_RETRY_ATTEMPTS = 5
const TOKEN_INTERACTIVE_COOLDOWN_MS = 30_000

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

const LOCAL_E2E_AUTH_TOGGLE_KEY = 'phw_e2e_local_auth'
const LOCAL_E2E_AUTH_ROLE_KEY = 'phw_e2e_role'

function isLocalE2EAuthEnabled(): boolean {
  return (import.meta.env.VITE_E2E_LOCAL_AUTH as string | undefined) === '1'
}

function mapLocalRole(raw: string | null | undefined): AppRole {
  const normalized = (raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_')
  if (normalized === ROLES.ADMIN) {
    return ROLES.ADMIN
  }
  if (normalized === ROLES.EVENT_CREATOR) {
    return ROLES.EVENT_CREATOR
  }
  if (normalized === ROLES.TAVF_CREATOR) {
    return ROLES.TAVF_CREATOR
  }
  return ROLES.USER
}

function readLocalE2ERole(): AppRole {
  if (typeof window === 'undefined') {
    return ROLES.USER
  }
  return mapLocalRole(window.localStorage.getItem(LOCAL_E2E_AUTH_ROLE_KEY))
}

function localRoleSet(role: AppRole): AppRole[] {
  if (role === ROLES.ADMIN) {
    return [ROLES.ADMIN, ROLES.EVENT_CREATOR, ROLES.TAVF_CREATOR, ROLES.USER]
  }
  if (role === ROLES.EVENT_CREATOR) {
    return [ROLES.EVENT_CREATOR, ROLES.TAVF_CREATOR, ROLES.USER]
  }
  if (role === ROLES.TAVF_CREATOR) {
    return [ROLES.TAVF_CREATOR, ROLES.USER]
  }
  return [ROLES.USER]
}

function localRoleToken(role: AppRole): string {
  if (role === ROLES.ADMIN) {
    return 'e2e-admin'
  }
  if (role === ROLES.EVENT_CREATOR) {
    return 'e2e-event_creator'
  }
  if (role === ROLES.TAVF_CREATOR) {
    return 'e2e-tavf_creator'
  }
  return 'e2e-user'
}

function getApiBaseUrl(): string {
  const rawBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1').trim()
  const normalized = rawBase.endsWith('/') ? rawBase.slice(0, -1) : rawBase
  return normalized.length > 0 ? normalized : '/api/v1'
}

function useAuth() {
  const localE2EAuth = isLocalE2EAuthEnabled()
  const { accounts, instance, inProgress } = useMsal()
  const interactionBusy = inProgress !== InteractionStatus.None
  const isAuthenticated = useIsAuthenticated()
  const account = accounts[0] ?? null
  const loginRequestRef = useRef<Promise<void> | null>(null)
  const tokenInteractiveInFlightRef = useRef(false)
  const tokenInteractiveCooldownUntilRef = useRef(0)
  const tokenRequestInFlightRef = useRef<Promise<string | null> | null>(null)
  const tokenCacheRef = useRef<CachedAccessToken | null>(null)

  const accountClaims = account?.idTokenClaims as Record<string, unknown> | undefined
  const [resolvedRoles, setResolvedRoles] = useState<AppRole[]>(() => mapRoles(accountClaims))
  const [rolesReady, setRolesReady] = useState(() => {
    if (!account) {
      return true
    }
    return mapRoles(accountClaims).length > 0
  })
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [localE2ERole, setLocalE2ERole] = useState<AppRole>(() => readLocalE2ERole())

  useEffect(() => {
    if (!localE2EAuth || typeof window === 'undefined') {
      return
    }

    setLocalE2ERole(readLocalE2ERole())

    const onStorage = (event: StorageEvent) => {
      if (event.key === LOCAL_E2E_AUTH_ROLE_KEY || event.key === LOCAL_E2E_AUTH_TOGGLE_KEY) {
        setLocalE2ERole(readLocalE2ERole())
      }
    }

    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
    }
  }, [localE2EAuth])

  useEffect(() => {
    setResolvedRoles(mapRoles(accountClaims))
  }, [accountClaims])

  useEffect(() => {
    if (!account) {
      setRolesReady(true)
      return
    }

    const initialRoles = mapRoles(accountClaims)
    setRolesReady(initialRoles.length > 0)
  }, [account, accountClaims])

  const ensureBackendRoles = useCallback(async (): Promise<AppRole[]> => {
    if (localE2EAuth || !account || interactionBusy) {
      return []
    }

    try {
      const tokenResponse = await instance.acquireTokenSilent({
        ...loginRequest,
        account,
      })

      const headers: Record<string, string> = {
        Authorization: `Bearer ${tokenResponse.accessToken}`,
      }

      const emailHint = resolveEmailHint(accountClaims, account.username)
      if (emailHint.includes('@')) {
        headers['X-Id-Token-Email'] = emailHint
      }

      const response = await fetch(`${getApiBaseUrl()}/members/me`, {
        method: 'GET',
        headers,
      })

      if (!response.ok) {
        throw new Error(`members/me failed (${response.status})`)
      }

      const me = (await response.json()) as { auth_roles?: unknown }
      const backendRoles = Array.isArray(me.auth_roles)
        ? me.auth_roles.filter((role): role is AppRole => Object.values(ROLES).includes(role as AppRole))
        : []

      if (backendRoles.length > 0) {
        setResolvedRoles((current) => mergeRoles(current, backendRoles))
        setRolesReady(true)
        authDebugLog('roles:backend:merged', {
          account: account.username,
          backendRoles,
        })
      }

      return backendRoles
    } catch (error: unknown) {
      authDebugWarn('roles:backend:unavailable', {
        account: account.username,
        message: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }, [account, accountClaims, instance, interactionBusy, localE2EAuth])

  useEffect(() => {
    let cancelled = false

    async function hydrateBackendRoles() {
      const backendRoles = await ensureBackendRoles()
      if (!cancelled && backendRoles.length > 0) {
        setRolesReady(true)
      }
    }

    void hydrateBackendRoles()

    return () => {
      cancelled = true
    }
  }, [ensureBackendRoles])

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
          setResolvedRoles(mergeRoles(
            mapRoles(refreshedClaims),
            mapRoles(decodeJwtPayload(tokenResponse.accessToken)),
          ))
          setRolesReady(true)
        }
      } catch {
        // Keep previously derived roles if forced refresh is unavailable.
      } finally {
        if (!cancelled) {
          setRolesReady(true)
        }
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
  const resolvedEmail = resolveEmailHint(accountClaims, account?.username)

  const user: AuthUser | null = account
    ? {
        id: subjectClaim ?? account.localAccountId,
        name: account.name ?? account.username ?? 'User',
        email: resolvedEmail,
        roles: resolvedRoles,
      }
    : null

  function hasRole(role: AppRole): boolean {
    if (localE2EAuth) {
      return localRoleSet(localE2ERole).includes(role)
    }
    return user?.roles.includes(role) ?? false
  }

  function isAdmin(): boolean {
    return hasRole(ROLES.ADMIN)
  }

  function canCreateEvents(): boolean {
    return hasRole(ROLES.ADMIN) || hasRole(ROLES.EVENT_CREATOR)
  }

  function canCreateTavfPostings(): boolean {
    return Boolean(user) && (!isAdmin() || hasRole(ROLES.TAVF_CREATOR) || hasRole(ROLES.EVENT_CREATOR))
  }

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
    if (localE2EAuth) {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(LOCAL_E2E_AUTH_TOGGLE_KEY, '1')
        if (!window.localStorage.getItem(LOCAL_E2E_AUTH_ROLE_KEY)) {
          window.localStorage.setItem(LOCAL_E2E_AUTH_ROLE_KEY, ROLES.USER)
        }
      }
      setLocalE2ERole(readLocalE2ERole())
      setLoginError(null)
      return
    }

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
        if (
          code === 'timed_out'
          || message.toLowerCase().includes('timed_out')
          || code === 'popup_window_timeout'
        ) {
          const recoveredAccount = await waitForSignedInAccount(instance, LOGIN_ACCOUNT_RECOVERY_TIMEOUT_MS)
          if (recoveredAccount) {
            instance.setActiveAccount(recoveredAccount)
            setLoginError(null)
            authDebugWarn('login:popup:timed-out-but-recovered', {
              username: recoveredAccount.username,
            })
            return
          }

          setLoginError('Sign-in is still in progress. If you completed the popup, wait a few seconds and tap Sign in once more.')
          return
        }
        if (code === 'popup_window_error' || message.toLowerCase().includes('popup')) {
          setLoginError('Your browser blocked the sign-in window. Please allow popups and cross-site cookies for this site, then try again.')
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
    if (localE2EAuth) {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(LOCAL_E2E_AUTH_ROLE_KEY)
      }
      setLocalE2ERole(ROLES.USER)
      return
    }

    await instance.logoutPopup({
      account: account ?? undefined,
      postLogoutRedirectUri: popupRedirectUri ?? null,
      mainWindowRedirectUri: `${window.location.origin}/login`,
    })
  }

  useEffect(() => {
    if (localE2EAuth) {
      setTokenGetter(async () => localRoleToken(localE2ERole))
      setEmailHint(null)
      return
    }

    setEmailHint(resolveEmailHint(accountClaims, account?.username))

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

          setResolvedRoles((current) => mergeRoles(
            current,
            mapRoles(decodeJwtPayload(tokenResponse.accessToken)),
          ))
          setRolesReady(true)

          return tokenResponse.accessToken
        } catch (error: unknown) {
          const shouldTreatAsInteractionRequired = isInteractionRequired(error) || isSilentTimeoutLikeError(error)

          if (!shouldTreatAsInteractionRequired) {
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

          const now = Date.now()
          if (now < tokenInteractiveCooldownUntilRef.current) {
            authDebugWarn('token:popup:cooldown:active', {
              account: account.username,
              retryInMs: tokenInteractiveCooldownUntilRef.current - now,
            })
            return null
          }

          authDebugWarn('token:silent:interaction-required', {
            account: account.username,
            interactionBusy,
            hasLoginRequestInFlight: Boolean(loginRequestRef.current),
          })

          if (interactionBusy || loginRequestRef.current) {
            authDebugWarn('token:popup:skipped:interaction-busy')

            // During initial sign-in, API requests can race token readiness.
            // Wait briefly and retry silent acquisition before giving up.
            for (let attempt = 0; attempt < TOKEN_BUSY_RETRY_ATTEMPTS; attempt += 1) {
              await wait(TOKEN_BUSY_RETRY_MS)
              try {
                const retryToken = await instance.acquireTokenSilent({
                  ...loginRequest,
                  account,
                })

                if (retryToken.expiresOn) {
                  tokenCacheRef.current = {
                    token: retryToken.accessToken,
                    expiresAtMs: retryToken.expiresOn.getTime(),
                  }
                }

                authDebugLog('token:silent:retry-after-busy:success', {
                  account: account.username,
                  attempt: attempt + 1,
                })
                return retryToken.accessToken
              } catch {
                // Keep retrying until attempts are exhausted.
              }
            }

            authDebugWarn('token:silent:retry-after-busy:exhausted', {
              account: account.username,
            })
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

              setResolvedRoles((current) => mergeRoles(
                current,
                mapRoles(decodeJwtPayload(tokenResponse.accessToken)),
              ))
                setRolesReady(true)

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
                tokenInteractiveCooldownUntilRef.current = Date.now() + TOKEN_INTERACTIVE_COOLDOWN_MS
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
  }, [account, accountClaims, instance, interactionBusy, localE2EAuth, localE2ERole])

  const localUser: AuthUser = {
    id: `e2e-${localE2ERole.toLowerCase()}`,
    name: `E2E ${localE2ERole}`,
    email: `${localE2ERole.toLowerCase()}@local.e2e`,
    roles: localRoleSet(localE2ERole),
  }

  const effectiveUser = localE2EAuth ? localUser : user
  const effectiveIsAuthenticated = localE2EAuth ? true : isAuthenticated
  const effectiveInteractionBusy = localE2EAuth ? false : interactionBusy
  const effectiveRolesReady = localE2EAuth ? true : rolesReady

  return {
    hasRole,
    isAdmin,
    canCreateEvents,
    canCreateTavfPostings,
    ensureBackendRoles,
    isAuthenticated: effectiveIsAuthenticated,
    login,
    logout,
    user: effectiveUser,
    interactionBusy: effectiveInteractionBusy,
    isLoggingIn,
    loginError,
    rolesReady: effectiveRolesReady,
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

async function waitForSignedInAccount(
  instance: ReturnType<typeof useMsal>['instance'],
  timeoutMs: number,
): Promise<ReturnType<typeof instance.getAllAccounts>[number] | null> {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    const found = instance.getActiveAccount() ?? instance.getAllAccounts()[0] ?? null
    if (found) {
      return found
    }
    await wait(LOGIN_ACCOUNT_RECOVERY_POLL_MS)
  }

  return null
}

function isInteractionRequired(error: unknown): boolean {
  const code = (error as { errorCode?: string } | null)?.errorCode?.toLowerCase() ?? ''
  return code.includes('interaction_required')
    || code.includes('consent_required')
    || code.includes('login_required')
    || code.includes('no_tokens_found')
}

function isSilentTimeoutLikeError(error: unknown): boolean {
  const errorLike = error as { errorCode?: string; message?: string } | null
  const code = errorLike?.errorCode?.toLowerCase() ?? ''
  const message = errorLike?.message?.toLowerCase() ?? ''

  return code.includes('timed_out')
    || code.includes('monitor_window_timeout')
    || code.includes('iframe_closed_prematurely')
    || message.includes('timed_out')
    || message.includes('monitor_window_timeout')
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
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

function normalizeEmailHintValue(value: string | null | undefined): string {
  const normalized = (value ?? '').trim()
  if (!normalized) {
    return ''
  }

  const extIndex = normalized.toLowerCase().indexOf('#ext#@')
  if (extIndex > 0) {
    const localAndDomain = normalized.slice(0, extIndex)
    const separatorIndex = localAndDomain.lastIndexOf('_')
    if (separatorIndex > 0 && separatorIndex < localAndDomain.length - 1) {
      const localPart = localAndDomain.slice(0, separatorIndex)
      const domainPart = localAndDomain.slice(separatorIndex + 1)
      if (localPart && domainPart) {
        return `${localPart}@${domainPart}`.toLowerCase()
      }
    }
  }

  return normalized.includes('@') ? normalized.toLowerCase() : ''
}

function resolveEmailHint(claims: Record<string, unknown> | undefined, fallback: string | null | undefined): string {
  const directKeys = ['email', 'preferred_username', 'upn']
  if (claims) {
    for (const key of directKeys) {
      const raw = claims[key]
      if (typeof raw === 'string') {
        const normalized = normalizeEmailHintValue(raw)
        if (normalized) {
          return normalized
        }
      }
    }

    const arrayKeys = ['emails', 'otherMails']
    for (const key of arrayKeys) {
      const raw = claims[key]
      if (Array.isArray(raw)) {
        const first = raw.find((value): value is string => typeof value === 'string' && value.trim().length > 0)
        if (first) {
          const normalized = normalizeEmailHintValue(first)
          if (normalized) {
            return normalized
          }
        }
      }
    }
  }

  return normalizeEmailHintValue(fallback)
}

function mapRoles(claims: Record<string, unknown> | undefined): AppRole[] {
  const rawRoleValues = extractRoleValues(claims)
  return rawRoleValues
    .map(normalizeRole)
    .filter((role): role is AppRole => Boolean(role))
    .filter((role, index, all) => all.indexOf(role) === index)
}

function mergeRoles(...roleSets: AppRole[][]): AppRole[] {
  const merged: AppRole[] = []
  for (const roles of roleSets) {
    for (const role of roles) {
      if (!merged.includes(role)) {
        merged.push(role)
      }
    }
  }
  return merged
}

function decodeJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) {
    return undefined
  }

  const parts = token.split('.')
  if (parts.length < 2) {
    return undefined
  }

  const payloadPart = parts[1]
  if (!payloadPart) {
    return undefined
  }

  try {
    const base64 = payloadPart.replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4)
    const decoded = atob(padded)
    return JSON.parse(decoded) as Record<string, unknown>
  } catch {
    return undefined
  }
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

  if (['TAVFCREATOR', 'TAVF_GUIDE', 'GUIDE'].includes(normalized)) {
    return ROLES.TAVF_CREATOR
  }

  return null
}

export { useAuth }