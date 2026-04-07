import { InteractionStatus } from '@azure/msal-browser'
import { useIsAuthenticated, useMsal } from '@azure/msal-react'
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import type { AppRole } from '../authConfig'
import { useAuth } from '../hooks/useAuth'
import { authDebugLog } from '../utils/authDebug'

interface ProtectedRouteProps {
  children: ReactNode
  requiredRole?: AppRole
  requiredRoles?: AppRole[]
  disallowedRoles?: AppRole[]
}

function ProtectedRoute({ children, requiredRole, requiredRoles, disallowedRoles }: ProtectedRouteProps) {
  const { accounts, inProgress } = useMsal()
  const isAuthenticated = useIsAuthenticated()
  const { hasRole } = useAuth()
  const location = useLocation()
  const lastDecisionRef = useRef<string | null>(null)
  const authReady = inProgress === InteractionStatus.None
  const hasKnownAccount = accounts.length > 0

  useEffect(() => {
    const snapshot = JSON.stringify({
      path: location.pathname,
      isAuthenticated,
      inProgress,
      accountCount: accounts.length,
      requiredRole,
      requiredRoles,
      disallowedRoles,
    })

    if (snapshot !== lastDecisionRef.current) {
      authDebugLog('ProtectedRoute:state', {
        path: location.pathname,
        isAuthenticated,
        inProgress,
        accountCount: accounts.length,
        requiredRole,
        requiredRoles,
        disallowedRoles,
      })
      lastDecisionRef.current = snapshot
    }
  }, [accounts.length, disallowedRoles, inProgress, isAuthenticated, location.pathname, requiredRole, requiredRoles])

  if (!authReady) {
    authDebugLog('ProtectedRoute:decision:wait-auth-ready', {
      path: location.pathname,
      inProgress,
    })
    return null
  }

  if (!isAuthenticated && !hasKnownAccount) {
    authDebugLog('ProtectedRoute:decision:redirect-login', {
      path: location.pathname,
      isAuthenticated,
      hasKnownAccount,
    })
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (requiredRole && !hasRole(requiredRole)) {
    authDebugLog('ProtectedRoute:decision:redirect-dashboard:requiredRole', {
      path: location.pathname,
      requiredRole,
    })
    return <Navigate to="/dashboard" replace />
  }

  if (requiredRoles && !requiredRoles.some((role) => hasRole(role))) {
    authDebugLog('ProtectedRoute:decision:redirect-dashboard:requiredRoles', {
      path: location.pathname,
      requiredRoles,
    })
    return <Navigate to="/dashboard" replace />
  }

  if (disallowedRoles && disallowedRoles.some((role) => hasRole(role))) {
    authDebugLog('ProtectedRoute:decision:redirect-dashboard:disallowedRoles', {
      path: location.pathname,
      disallowedRoles,
    })
    return <Navigate to="/dashboard" replace />
  }

  authDebugLog('ProtectedRoute:decision:allow', {
    path: location.pathname,
  })

  return <>{children}</>
}

export { ProtectedRoute }