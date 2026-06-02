import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'

function TenantNoAccessPage() {
  const navigate = useNavigate()
  const { logout } = useAuth()
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  async function handleBackToSignIn() {
    setIsSigningOut(true)
    setSignOutError(null)

    try {
      await logout()
      navigate('/login', { replace: true })
    } catch (error) {
      console.error('[tenant-no-access] Sign-out failed', error)
      setSignOutError('Sign-out could not complete. Please close this tab and open the app again.')
    } finally {
      setIsSigningOut(false)
    }
  }

  return (
    <section className="page" style={{ maxWidth: 760, margin: '0 auto', textAlign: 'center' }}>
      <h1>No Tenant Access</h1>
      <p className="events-subtitle" style={{ marginTop: 12 }}>
        Your account is authenticated, but no active tenant memberships were found.
      </p>
      <p style={{ color: '#475569' }}>
        Contact chapter support if this looks incorrect.
      </p>
      <div style={{ marginTop: 20, display: 'flex', gap: 12, justifyContent: 'center' }}>
        <a className="btn btn--outline" href="mailto:accessibility@phwcoloradoalpine.org">Contact support</a>
        <button className="btn btn--primary" type="button" onClick={handleBackToSignIn} disabled={isSigningOut}>
          {isSigningOut ? 'Signing out...' : 'Back to sign in'}
        </button>
      </div>
      {signOutError ? <p className="events-error" role="alert" style={{ marginTop: 16 }}>{signOutError}</p> : null}
    </section>
  )
}

export { TenantNoAccessPage }
