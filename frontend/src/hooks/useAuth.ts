import { useEffect } from 'react'
import { useIsAuthenticated, useMsal } from '@azure/msal-react'
import { loginRequest, ROLES } from '../authConfig'
import type { AppRole } from '../authConfig'
import { setTokenGetter } from '../api/client'

interface AuthUser {
  name: string
  email: string
  roles: AppRole[]
}

function useAuth() {
  const { accounts, instance } = useMsal()
  const isAuthenticated = useIsAuthenticated()
  const account = accounts[0] ?? null

  const rawRoles = Array.isArray(account?.idTokenClaims?.roles)
    ? (account?.idTokenClaims?.roles as string[])
    : []

  const user: AuthUser | null = account
    ? {
        name: account.name ?? account.username ?? 'User',
        email: account.username,
        roles: rawRoles.filter((role): role is AppRole => Object.values(ROLES).includes(role as AppRole)),
      }
    : null

  function hasRole(role: AppRole): boolean {
    return user?.roles.includes(role) ?? false
  }

  function isAdmin(): boolean {
    return hasRole(ROLES.ADMIN)
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

  return { hasRole, isAdmin, isAuthenticated, login, logout, user }
}

export { useAuth }