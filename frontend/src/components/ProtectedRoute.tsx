import { Navigate, useLocation } from 'react-router-dom';
import { useIsAuthenticated } from '@azure/msal-react';
import { useAuth } from '../hooks/useAuth';
import type { AppRole } from '../authConfig';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredRole?: AppRole;
}

export function ProtectedRoute({ children, requiredRole }: ProtectedRouteProps) {
  const isAuthenticated = useIsAuthenticated();
  const { hasRole } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (requiredRole && !hasRole(requiredRole)) {
    return <Navigate to="/dashboard" replace />;
  }

  return <>{children}</>;
}
