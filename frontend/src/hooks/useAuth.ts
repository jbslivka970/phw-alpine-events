import { useCallback, useEffect, useRef, useState } from 'react'
import { useIsAuthenticated, useMsal } from '@azure/msal-react'
import { InteractionStatus } from '@azure/msal-browser'
import { hasAuthConfig, loginRequest, popupRedirectUri, ROLES } from '../authConfig'
import type { AppRole } from '../authConfig'
import { getApiBaseUrl as resolveApiBaseUrl } from '../api/baseUrl'
import { setEmailHint, setMemberInviteToken, setTokenGetter } from '../api/client'
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

type SharedRoleState = {
  accountKey: string | null
  roles: AppRole[]
  rolesReady: boolean
}

const LOCAL_E2E_AUTH_TOGGLE_KEY = 'phw_e2e_local_auth'
const LOCAL_E2E_AUTH_ROLE_KEY = 'phw_e2e_role'
const EXTERNAL_E2E_AUTH_TOGGLE_KEY = 'phw_e2e_external_auth'
const EXTERNAL_E2E_AUTH_TOKEN_KEY = 'phw_e2e_external_token'
const EXTERNAL_E2E_AUTH_EMAIL_KEY = 'phw_e2e_external_email'
const EXTERNAL_E2E_AUTH_USER_ID_KEY = 'phw_e2e_external_user_id'
let sharedRoleState: SharedRoleState = {
  accountKey: null,
  roles: [],
  rolesReady: true,
}
const sharedRoleSubscribers = new Set<(state: SharedRoleState) => void>()

function isLocalE2EAuthEnabled(): boolean {
  return (import.meta.env.VITE_E2E_LOCAL_AUTH as string | undefined) === '1'
}

function isExternalE2EAuthEnabled(): boolean {
  return (import.meta.env.VITE_E2E_EXTERNAL_AUTH as string | undefined) === '1'
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

function readExternalE2EToken(): string | null {
  if (typeof window === 'undefined') {
    return null
  }

  const enabled = window.localStorage.getItem(EXTERNAL_E2E_AUTH_TOGGLE_KEY) === '1'
  if (!enabled) {
    return null
  }

  const token = (window.localStorage.getItem(EXTERNAL_E2E_AUTH_TOKEN_KEY) ?? '').trim()
  return token.length > 0 ? token : null
}

function readExternalE2EEmail(): string | null {
  if (typeof window === 'undefined') {
    return null
  }

  const value = (window.localStorage.getItem(EXTERNAL_E2E_AUTH_EMAIL_KEY) ?? '').trim()
  return value.length > 0 ? value : null
}

function readExternalE2EUserId(): string | null {
  if (typeof window === 'undefined') {
    return null
  }

  const value = (window.localStorage.getItem(EXTERNAL_E2E_AUTH_USER_ID_KEY) ?? '').trim()
  return value.length > 0 ? value : null
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
  return resolveApiBaseUrl()
}

function getAccountKey(localAccountId: string | null | undefined): string | null {
  const normalized = (localAccountId ?? '').trim()
  return normalized || null
}

function mergeWithSharedRoles(accountKey: string | null, roles: AppRole[]): AppRole[] {
  if (!accountKey || sharedRoleState.accountKey !== accountKey) {
    return roles
  }

  return mergeRoles(roles, sharedRoleState.roles)
}

function publishSharedRoles(accountKey: string | null, roles: AppRole[], rolesReady: boolean): void {
  sharedRoleState = {
    accountKey,
    roles,
    rolesReady,
  }

  for (const subscriber of sharedRoleSubscribers) {
    subscriber(sharedRoleState)
  }
}

function useAuth() {
  const localE2EAuth = isLocalE2EAuthEnabled()
  const externalE2EAuth = isExternalE2EAuthEnabled()
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
  const accountKey = getAccountKey(account?.localAccountId)
  const [resolvedRoles, setResolvedRoles] = useState<AppRole[]>(() => mergeWithSharedRoles(accountKey, mapRoles(accountClaims)))
  const [rolesReady, setRolesReady] = useState(() => {
    if (!account) {
      return true
    }
    const initialRoles = mergeWithSharedRoles(accountKey, mapRoles(accountClaims))
    if (sharedRoleState.accountKey === accountKey) {
      return sharedRoleState.rolesReady || initialRoles.length > 0
    }
    return initialRoles.length > 0
  })
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [localE2ERole, setLocalE2ERole] = useState<AppRole>(() => readLocalE2ERole())
  const [externalE2EToken, setExternalE2EToken] = useState<string | null>(() => readExternalE2EToken())
  const [externalE2EEmail, setExternalE2EEmail] = useState<string | null>(() => readExternalE2EEmail())
  const [externalE2EUserId, setExternalE2EUserId] = useState<string | null>(() => readExternalE2EUserId())

  const externalE2ESessionActive = externalE2EAuth && Boolean(externalE2EToken)
  const e2eModeActive = localE2EAuth || externalE2ESessionActive

  useEffect(() => {
    if ((!localE2EAuth && !externalE2EAuth) || typeof window === 'undefined') {
      return
    }

    const syncE2EState = () => {
      setLocalE2ERole(readLocalE2ERole())
      setExternalE2EToken(readExternalE2EToken())
      setExternalE2EEmail(readExternalE2EEmail())
      setExternalE2EUserId(readExternalE2EUserId())
    }

    syncE2EState()

    const onStorage = (event: StorageEvent) => {
      if (
        event.key === LOCAL_E2E_AUTH_ROLE_KEY
        || event.key === LOCAL_E2E_AUTH_TOGGLE_KEY
        || event.key === EXTERNAL_E2E_AUTH_TOGGLE_KEY
        || event.key === EXTERNAL_E2E_AUTH_TOKEN_KEY
        || event.key === EXTERNAL_E2E_AUTH_EMAIL_KEY
        || event.key === EXTERNAL_E2E_AUTH_USER_ID_KEY
      ) {
        syncE2EState()
      }
    }

    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('storage', onStorage)
    }
  }, [externalE2EAuth, localE2EAuth])

  useEffect(() => {
    const nextRoles = mergeWithSharedRoles(accountKey, mapRoles(accountClaims))
    setResolvedRoles(nextRoles)

    if (!account) {
      setRolesReady(true)
      return
    }

    if (sharedRoleState.accountKey === accountKey) {
      setRolesReady(sharedRoleState.rolesReady || nextRoles.length > 0)
      return
    }

    setRolesReady(nextRoles.length > 0)
  }, [account, accountClaims, accountKey])

  useEffect(() => {
    if (!account) {
      setRolesReady(true)
      return
    }

    const initialRoles = mergeWithSharedRoles(accountKey, mapRoles(accountClaims))
    setRolesReady(initialRoles.length > 0 || (sharedRoleState.accountKey === accountKey && sharedRoleState.rolesReady))
  }, [account, accountClaims, accountKey])

  useEffect(() => {
    const subscriber = (state: SharedRoleState) => {
      if (!accountKey || state.accountKey !== accountKey) {
        return
      }

      setResolvedRoles((current) => mergeRoles(current, state.roles))
      setRolesReady(state.rolesReady || state.roles.length > 0)
    }

    sharedRoleSubscribers.add(subscriber)
    return () => {
      sharedRoleSubscribers.delete(subscriber)
    }
  }, [accountKey])

  const acquireAccessToken = useCallback(async (): Promise<string | null> => {
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
  }, [account, instance, interactionBusy, popupRedirectUri])

  const ensureBackendRoles = useCallback(async (): Promise<AppRole[]> => {
    if (localE2EAuth || !account || interactionBusy) {
      return []
    }

    let accessToken: string | null = null
    try {
      accessToken = await acquireAccessToken()
    } catch (error: unknown) {
      authDebugWarn('roles:backend:unavailable', {
        account: account.username,
        stage: 'token',
        message: error instanceof Error ? error.message : String(error),
      })
      return []
    }

    if (!accessToken) {
      return []
    }

    const emailHintHeader = resolveEmailHintHeader(accountClaims, account.username)
    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
    }

    const headersWithHint: Record<string, string> = emailHintHeader
      ? { ...baseHeaders, 'X-Id-Token-Email': emailHintHeader }
      : baseHeaders

    const membersMeUrl = `${getApiBaseUrl()}/members/me`

    const requestMembersMe = async (
      headers: Record<string, string>,
    ): Promise<Response> => fetch(membersMeUrl, { method: 'GET', headers })

    let response: Response
    let usedEmailHintHeader = Boolean(emailHintHeader)
    try {
      response = await requestMembersMe(headersWithHint)
    } catch (firstError: unknown) {
      // Some browsers (notably Safari/WebKit) reject `fetch()` with
      // `TypeError: The string did not match the expected pattern.` when a
      // header value contains anything outside header-safe ASCII. The
      // X-Id-Token-Email header is purely an optional backend hint — the
      // server can resolve the caller from the access token alone — so if the
      // request was rejected and we attached that header, retry once without
      // it before giving up.
      const isTypeError = firstError instanceof TypeError
      if (!emailHintHeader || !isTypeError) {
        authDebugWarn('roles:backend:unavailable', {
          account: account.username,
          stage: 'request',
          hasEmailHintHeader: Boolean(emailHintHeader),
          message: firstError instanceof Error ? firstError.message : String(firstError),
        })
        return []
      }

      authDebugWarn('roles:backend:retry-without-hint', {
        account: account.username,
        message: firstError instanceof Error ? firstError.message : String(firstError),
      })

      try {
        response = await requestMembersMe(baseHeaders)
        usedEmailHintHeader = false
      } catch (retryError: unknown) {
        authDebugWarn('roles:backend:unavailable', {
          account: account.username,
          stage: 'request',
          hasEmailHintHeader: false,
          message: retryError instanceof Error ? retryError.message : String(retryError),
        })
        return []
      }
    }

    try {
      if (!response.ok) {
        throw new Error(`members/me failed (${response.status})`)
      }

      const me = (await response.json()) as { auth_roles?: unknown }
      const backendRoles = Array.isArray(me.auth_roles)
        ? me.auth_roles.filter((role): role is AppRole => Object.values(ROLES).includes(role as AppRole))
        : []

      if (backendRoles.length > 0) {
        setResolvedRoles((current) => {
          const merged = mergeRoles(current, backendRoles)
          publishSharedRoles(accountKey, merged, true)
          return merged
        })
        setRolesReady(true)
        authDebugLog('roles:backend:merged', {
          account: account.username,
          backendRoles,
          usedEmailHintHeader,
        })
      }

      return backendRoles
    } catch (error: unknown) {
      authDebugWarn('roles:backend:unavailable', {
        account: account.username,
        stage: 'response',
        hasEmailHintHeader: usedEmailHintHeader,
        message: error instanceof Error ? error.message : String(error),
      })
      return []
    }
  }, [account, accountClaims, acquireAccessToken, interactionBusy, localE2EAuth])

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
          const mergedRoles = mergeWithSharedRoles(accountKey, mergeRoles(
            mapRoles(refreshedClaims),
            mapRoles(decodeJwtPayload(tokenResponse.accessToken)),
          ))
          setResolvedRoles(mergedRoles)
          if (accountKey && sharedRoleState.accountKey === accountKey && sharedRoleState.roles.length > 0) {
            publishSharedRoles(accountKey, mergedRoles, true)
          }
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
    if (e2eModeActive) {
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
    if (e2eModeActive) {
      return true
    }
    return Boolean(user)
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
    if (e2eModeActive) {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(LOCAL_E2E_AUTH_TOGGLE_KEY, '1')
        if (!window.localStorage.getItem(LOCAL_E2E_AUTH_ROLE_KEY)) {
          window.localStorage.setItem(LOCAL_E2E_AUTH_ROLE_KEY, ROLES.USER)
        }
      }
      setLocalE2ERole(readLocalE2ERole())
      setExternalE2EToken(readExternalE2EToken())
      setExternalE2EEmail(readExternalE2EEmail())
      setExternalE2EUserId(readExternalE2EUserId())
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
          prompt: 'login',
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
    if (e2eModeActive) {
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(LOCAL_E2E_AUTH_ROLE_KEY)
        window.localStorage.removeItem(EXTERNAL_E2E_AUTH_TOGGLE_KEY)
        window.localStorage.removeItem(EXTERNAL_E2E_AUTH_TOKEN_KEY)
        window.localStorage.removeItem(EXTERNAL_E2E_AUTH_EMAIL_KEY)
        window.localStorage.removeItem(EXTERNAL_E2E_AUTH_USER_ID_KEY)
      }
      setMemberInviteToken(null)
      setLocalE2ERole(ROLES.USER)
      setExternalE2EToken(null)
      setExternalE2EEmail(null)
      setExternalE2EUserId(null)
      return
    }

    setMemberInviteToken(null)

    await instance.logoutPopup({
      account: account ?? undefined,
      postLogoutRedirectUri: popupRedirectUri ?? null,
      mainWindowRedirectUri: `${window.location.origin}/login`,
    })
  }

  useEffect(() => {
    if (externalE2ESessionActive && externalE2EToken) {
      setTokenGetter(async () => externalE2EToken)
      setEmailHint(externalE2EEmail)
      return
    }

    if (localE2EAuth) {
      setTokenGetter(async () => localRoleToken(localE2ERole))
      setEmailHint(null)
      return
    }

    setEmailHint(resolveEmailHintHeader(accountClaims, account?.username))

    setTokenGetter(acquireAccessToken)
  }, [account, accountClaims, acquireAccessToken, externalE2EEmail, externalE2ESessionActive, externalE2EToken, localE2EAuth, localE2ERole])

  const localUser: AuthUser = {
    id: `e2e-${localE2ERole.toLowerCase()}`,
    name: `E2E ${localE2ERole}`,
    email: `${localE2ERole.toLowerCase()}@local.e2e`,
    roles: localRoleSet(localE2ERole),
  }

  const externalUser: AuthUser = {
    id: externalE2EUserId ?? `e2e-external-${localE2ERole.toLowerCase()}`,
    name: `E2E ${localE2ERole}`,
    email: externalE2EEmail ?? `${localE2ERole.toLowerCase()}@external.e2e`,
    roles: localRoleSet(localE2ERole),
  }

  const effectiveUser = localE2EAuth ? localUser : (externalE2ESessionActive ? externalUser : user)
  const effectiveIsAuthenticated = e2eModeActive ? true : isAuthenticated
  const effectiveInteractionBusy = e2eModeActive ? false : interactionBusy
  const effectiveRolesReady = e2eModeActive ? true : rolesReady

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
    || message.includes('the string did not match the expected pattern')
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

function firstNormalizedEmailValue(rawValue: unknown): string {
  if (typeof rawValue === 'string') {
    return normalizeEmailHintValue(rawValue)
  }

  if (Array.isArray(rawValue)) {
    for (const value of rawValue) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        continue
      }

      const normalized = normalizeEmailHintValue(value)
      if (normalized) {
        return normalized
      }
    }
  }

  return ''
}

function isSyntheticTenantPrincipalEmail(value: string): boolean {
  const normalized = normalizeEmailHintValue(value)
  if (!normalized) {
    return false
  }

  const [localPart = '', domainPart = ''] = normalized.split('@')
  return domainPart.endsWith('.onmicrosoft.com')
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(localPart)
}

// HTTP header values must be 7-bit, header-safe characters. Browsers (notably
// Safari/WebKit) throw `TypeError: The string did not match the expected
// pattern.` from `fetch()` when a header value contains anything outside
// printable ASCII (including non-Latin-1 letters or stray control bytes that
// can sneak in from federated identity claims). Any value that is not strictly
// safe to put on the wire MUST be omitted from the header — the backend can
// resolve identity from the access token and Graph fallback without it.
function isHeaderSafeAscii(value: string): boolean {
  // Allow only printable ASCII (no space, no controls, no high-bit / Unicode).
  return /^[\x21-\x7E]+$/.test(value)
}

function isUsableEmailHint(value: string | null | undefined): boolean {
  const normalized = normalizeEmailHintValue(value)
  if (!normalized || isSyntheticTenantPrincipalEmail(normalized)) {
    return false
  }

  if (!isHeaderSafeAscii(normalized)) {
    return false
  }

  return /^[^\s<>"'(),;:\[\]\\\r\n]+@[^\s<>"'(),;:\[\]\\\r\n]+\.[^\s<>"'(),;:\[\]\\\r\n]+$/.test(normalized)
}

function resolveEmailHint(claims: Record<string, unknown> | undefined, fallback: string | null | undefined): string {
  let fallbackCandidate = ''

  const considerValue = (rawValue: unknown): string => {
    const normalized = firstNormalizedEmailValue(rawValue)
    if (!normalized) {
      return ''
    }

    if (isUsableEmailHint(normalized)) {
      return normalized
    }

    if (!fallbackCandidate) {
      fallbackCandidate = normalized
    }

    return ''
  }

  const directKeys = ['email', 'preferred_username', 'upn']
  if (claims) {
    for (const key of directKeys) {
      const resolved = considerValue(claims[key])
      if (resolved) {
        return resolved
      }
    }

    const arrayKeys = ['emails', 'otherMails']
    for (const key of arrayKeys) {
      const resolved = considerValue(claims[key])
      if (resolved) {
        return resolved
      }
    }

    for (const [key, rawValue] of Object.entries(claims)) {
      if (!key.toLowerCase().includes('email')) {
        continue
      }

      const resolved = considerValue(rawValue)
      if (resolved) {
        return resolved
      }
    }
  }

  const fallbackNormalized = normalizeEmailHintValue(fallback)
  if (isUsableEmailHint(fallbackNormalized)) {
    return fallbackNormalized
  }

  return fallbackCandidate || fallbackNormalized
}

function resolveEmailHintHeader(claims: Record<string, unknown> | undefined, fallback: string | null | undefined): string | null {
  const resolved = resolveEmailHint(claims, fallback)
  return isUsableEmailHint(resolved) ? resolved : null
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