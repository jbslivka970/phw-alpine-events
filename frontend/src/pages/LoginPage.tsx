import { useEffect } from 'react'
import { useIsAuthenticated } from '@azure/msal-react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

function LoginPage() {
  const isAuthenticated = useIsAuthenticated()
  const navigate = useNavigate()
  const { login } = useAuth()

  useEffect(() => {
    if (isAuthenticated) {
      navigate('/dashboard', { replace: true })
    }
  }, [isAuthenticated, navigate])

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-card__badge">PHW</div>
        <h1 className="login-card__title">Alpine Events</h1>
        <p className="login-card__subtitle">Colorado Alpine Chapter</p>
        <p className="login-card__desc">
          Sign in with your configured chapter identity provider to access event management.
        </p>
        <button className="btn btn--primary btn--lg" onClick={login}>Sign in</button>
      </div>
    </div>
  )
}

export { LoginPage }