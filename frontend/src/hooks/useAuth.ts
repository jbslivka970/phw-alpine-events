import { useEffect, useState } from 'react'
import { useIsAuthenticated, useMsal } from '@azure/msal-react'
import { loginRequest, ROLES } from '../authConfig'
import type { AppRole } from '../authConfig'
import { setTokenGetter } from '../api/client'

interface AuthUser {
  id: string
  name: string
  email: string
  roles: AppRole[]
}

function useAuth() {
  const { accounts, instance } = useMsal()
  const isAuthenticated = useIsAuthenticated()
  const account = accounts[0] ?? null

  const accountClaims = account?.idTokenClaims as Record<string, unknown> | undefined
  const [resolvedRoles, setResolvedRoles] = useState<AppRole[]>(() => mapRoles(accountClaims))

  useEffect(() => {
    setResolvedRoles(mapRoles(accountClaims))
  }, [accountClaims])

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
  async function login() {
    try {
      await instance.loginPopup(loginRequest)
    } catch (error: unknown) {
      const code = (error as { errorCode?: string })?.errorCode
      if (code !== 'user_cancelled') {
        console.error('[MSAL] Login error:', error)
      }
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
      } catch {
        return null
      }
    })
  }, [account, instance])

  return { hasRole, isAdmin, canCreateEvents, isAuthenticated, login, logout, user }
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