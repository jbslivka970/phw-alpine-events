import { useEffect, useState } from 'react'
import { useIsAuthenticated } from '@azure/msal-react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

const LOGIN_HERO_PHOTOS = [
  '/PHW Photos/PHW-Hartsel25-1410.jpg',
  '/PHW Photos/PHW-Hartsel25-1247.jpg',
  '/PHW Photos/on the river tarrayall.jpg',
  '/PHW Photos/tarryall Creek fisherman.jpg',
  '/PHW Photos/PHW-Hartsel25-1429.jpg',
]

function LoginPage() {
  const isAuthenticated = useIsAuthenticated()
  const navigate = useNavigate()
  const location = useLocation()
  const { login, isLoggingIn, loginError } = useAuth()
  const [heroIndex] = useState(() => Math.floor(Math.random() * LOGIN_HERO_PHOTOS.length))

  const destination = (() => {
    const state = location.state as { from?: { pathname?: string } } | null
    const fromPath = state?.from?.pathname
    return fromPath && fromPath !== '/login' ? fromPath : '/dashboard'
  })()

  useEffect(() => {
    if (isAuthenticated) {
      navigate(destination, { replace: true })
    }
  }, [destination, isAuthenticated, navigate])

  return (
    <div className="login-page">
      <div className="login-page__hero">
        <img
          className="login-page__hero-img"
          src={LOGIN_HERO_PHOTOS[heroIndex]}
          alt="Colorado fly fishing"
        />
        <div className="login-page__hero-overlay" />
        <div className="login-page__hero-content">
          <p className="login-page__hero-tagline">
            &ldquo;Healing those who serve through the therapeutic art of fly fishing&rdquo;
          </p>
          <p className="login-page__hero-org">Project Healing Waters Fly Fishing</p>
        </div>
      </div>

      <div className="login-page__form-side">
        <div className="login-card">
          <img
            className="login-card__logo"
            src="/branding/PHW CO Alpine.png"
            alt="Project Healing Waters Colorado Alpine"
            onError={(event) => {
              event.currentTarget.style.display = 'none'
            }}
          />
          <h1 className="login-card__title">Alpine Events</h1>
          <p className="login-card__subtitle">Colorado Chapter</p>
          <p className="login-card__desc">
            Sign in with your chapter identity provider to manage events, RSVPs, and the Take a Vet Fishing program.
          </p>
          <div className="login-card__auth-help" role="note" aria-label="First-time sign-in help">
            <p className="login-card__auth-help-title">First-time sign-in steps</p>
            <ol className="login-card__auth-help-list">
              <li>Click Sign in.</li>
              <li>If using Google, choose Sign in with Google.</li>
              <li>If using email OTP for the first time, choose Create one, verify your code, then continue.</li>
            </ol>
          </div>
          <button className="btn btn--primary btn--lg" onClick={login} disabled={isLoggingIn}>
            {isLoggingIn ? 'Signing in...' : 'Sign in'}
          </button>
          {isLoggingIn && (
            <p className="login-card__desc" style={{ marginTop: 12 }}>
              A sign-in window should be open. Please complete the steps there, then return to this page.
            </p>
          )}
          {loginError && <p className="events-error" role="alert">{loginError}</p>}
          <div className="login-card__links">
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/sms-program">SMS Program</Link>
          </div>
        </div>
      </div>
    </div>
  )
}

export { LoginPage }