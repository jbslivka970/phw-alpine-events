import { useIsAuthenticated } from '@azure/msal-react'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import type { AppRole } from '../authConfig'
import { useAuth } from '../hooks/useAuth'

interface ProtectedRouteProps {
  children: ReactNode
  requiredRole?: AppRole
}

function ProtectedRoute({ children, requiredRole }: ProtectedRouteProps) {
  const isAuthenticated = useIsAuthenticated()
  const { hasRole } = useAuth()
  const location = useLocation()

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  if (requiredRole && !hasRole(requiredRole)) {
    return <Navigate to="/dashboard" replace />
  }

  return <>{children}</>
}

export { ProtectedRoute }