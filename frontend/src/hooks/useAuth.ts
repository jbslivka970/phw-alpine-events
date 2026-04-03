import { useEffect, useRef, useState } from 'react'
import { useIsAuthenticated, useMsal } from '@azure/msal-react'
import { InteractionStatus } from '@azure/msal-browser'
import { hasAuthConfig, loginRequest, ROLES } from '../authConfig'
import type { AppRole } from '../authConfig'
import { setTokenGetter } from '../api/client'

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
  const tokenRedirectInFlightRef = useRef(false)

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

  async function login() {
    if (!hasAuthConfig) {
      setLoginError('Sign-in is temporarily unavailable because Azure AD app settings are missing in this build. Please contact an administrator.')
      return
    }

    if (interactionBusy && !loginRequestRef.current) {
      setLoginError('Authentication is still finalizing from a previous attempt. Please try again in a moment.')
      return
    }

    if (loginRequestRef.current) {
      return loginRequestRef.current
    }

    setLoginError(null)
    setIsLoggingIn(true)

    loginRequestRef.current = (async () => {
      try {
        const response = await instance.loginPopup(loginRequest)
        if (response.account) {
          instance.setActiveAccount(response.account)
        }
      } catch (error: unknown) {
        const code = (error as { errorCode?: string })?.errorCode
        if (code === 'popup_window_error' || code === 'empty_window_error') {
          setLoginError('Popup blocked. Redirecting to sign-in...')
          await instance.loginRedirect(loginRequest)
          return
        }
        if (code === 'user_cancelled') {
          setLoginError('Sign-in was cancelled.')
          return
        }
        if (code === 'interaction_in_progress') {
          setLoginError('Another sign-in dialog is already in progress. Close it and try again.')
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
    } finally {
      loginRequestRef.current = null
      setIsLoggingIn(false)
    }
  }

  async function logout() {
    await instance.logoutPopup({ account: account ?? undefined })
  }

  useEffect(() => {
    setTokenGetter(async () => {
      if (!account) return null

      try {
        const tokenResponse = await instance.acquireTokenSilent({
          ...loginRequest,
          account,
        })
        return tokenResponse.accessToken
      } catch (error: unknown) {
        if (!isInteractionRequired(error)) {
          const code = (error as { errorCode?: string } | null)?.errorCode
          if (code !== 'interaction_in_progress') {
            console.error('[MSAL] Silent token acquisition failed:', error)
          }
          return null
        }

        if (interactionBusy || loginRequestRef.current) {
          return null
        }

        if (!tokenRedirectInFlightRef.current) {
          tokenRedirectInFlightRef.current = true
          try {
            await instance.acquireTokenRedirect({
              ...loginRequest,
              account,
            })
          } catch (redirectError: unknown) {
            const code = (redirectError as { errorCode?: string })?.errorCode
            if (code !== 'interaction_in_progress') {
              console.error('[MSAL] Redirect token acquisition failed:', redirectError)
            }
            tokenRedirectInFlightRef.current = false
          }
        }

        return null
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