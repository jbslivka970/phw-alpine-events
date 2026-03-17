import { useMsal, useIsAuthenticated } from '@azure/msal-react';
import { loginRequest, AppRole, ROLES } from '../authConfig';

export interface AuthUser {
  name: string;
  email: string;
  roles: AppRole[];
}

export function useAuth() {
  const { instance, accounts } = useMsal();
  const isAuthenticated = useIsAuthenticated();

  const account = accounts[0] ?? null;

  const user: AuthUser | null = account
    ? {
        name: account.name ?? account.username ?? 'User',
        email: account.username,
        roles: ((account.idTokenClaims as Record<string, unknown>)?.roles as AppRole[]) ?? [],
      }
    : null;

  function hasRole(role: AppRole): boolean {
    return user?.roles.includes(role) ?? false;
  }

  function isAdmin(): boolean {
    return hasRole(ROLES.ADMIN);
  }

  function isStaff(): boolean {
    return hasRole(ROLES.STAFF) || hasRole(ROLES.ADMIN);
  }

  async function login() {
    try {
      await instance.loginPopup(loginRequest);
    } catch (err: unknown) {
      // Ignore user-cancelled popups (BrowserAuthError code "user_cancelled")
      const code = (err as { errorCode?: string })?.errorCode;
      if (code && code !== 'user_cancelled') {
        console.error('[MSAL] Login error:', err);
      }
    }
  }

  async function logout() {
    await instance.logoutPopup({ account });
  }

  return { isAuthenticated, user, login, logout, hasRole, isAdmin, isStaff };
}
