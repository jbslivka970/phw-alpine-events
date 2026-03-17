import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useIsAuthenticated } from '@azure/msal-react';
import { useAuth } from '../hooks/useAuth';

export function LoginPage() {
  const isAuthenticated = useIsAuthenticated();
  const { login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/dashboard', { replace: true });
    }
  }, [isAuthenticated, navigate]);

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card__logo">⛷</div>
        <h1 className="login-card__title">PHW Alpine Events</h1>
        <p className="login-card__subtitle">Colorado Alpine Chapter</p>
        <p className="login-card__desc">
          Sign in with your PHW organisational account to manage events, RSVPs,
          and chapter communications.
        </p>
        <button className="btn btn--primary btn--lg" onClick={login}>
          Sign in with Microsoft
        </button>
      </div>
    </div>
  );
}
