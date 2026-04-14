import { Link, useSearchParams } from 'react-router-dom'

type EntryMode = 'rsvp' | 'sms' | 'signin'

function sanitizeNextPath(value: string | null): string {
  if (!value || !value.startsWith('/')) {
    return '/login'
  }
  return value
}

function FirstTimeOnboardingPage() {
  const [searchParams] = useSearchParams()
  const entry = (searchParams.get('entry') ?? 'signin').toLowerCase() as EntryMode
  const nextPath = sanitizeNextPath(searchParams.get('next'))

  const heading = entry === 'rsvp'
    ? 'First-time RSVP Help'
    : entry === 'sms'
      ? 'First-time SMS Help'
      : 'First-time Sign-in Help'

  return (
    <div className="login-page onboarding-page">
      <div className="login-page__form-side onboarding-page__single-column">
        <div className="login-card onboarding-card">
          <img
            className="login-card__logo"
            src="/branding/PHW CO Alpine.png"
            alt="Project Healing Waters Colorado Alpine"
            onError={(event) => {
              event.currentTarget.style.display = 'none'
            }}
          />
          <h1 className="login-card__title">{heading}</h1>
          <p className="login-card__desc">
            Use these steps if this is your first time joining PHW Alpine Events from an invite link or text message.
          </p>

          <div className="login-card__auth-help" role="note" aria-label="First-time onboarding steps">
            <p className="login-card__auth-help-title">Recommended flow</p>
            <ol className="login-card__auth-help-list">
              <li>If you have an RSVP link, open it first and submit your response.</li>
              <li>When you want full portal access, select Sign in and complete your provider flow.</li>
              <li>If prompted for account setup, complete verification and continue.</li>
              <li>If sign-in fails, contact your chapter admin to confirm your member email and invite status.</li>
            </ol>
          </div>

          <div className="onboarding-card__actions">
            <Link className="btn btn--primary btn--lg" to={nextPath}>Continue</Link>
            <Link className="btn btn--outline btn--lg" to="/login">Go to Sign in</Link>
          </div>

          <div className="login-card__links">
            <Link to="/about">About</Link>
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms</Link>
            <Link to="/sms-program">SMS Program</Link>
          </div>
        </div>
      </div>
    </div>
  )
}

export { FirstTimeOnboardingPage }
