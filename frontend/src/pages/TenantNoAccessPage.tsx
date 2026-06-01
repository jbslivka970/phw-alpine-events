import { Link } from 'react-router-dom'

function TenantNoAccessPage() {
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
        <Link className="btn btn--primary" to="/login">Back to sign in</Link>
      </div>
    </section>
  )
}

export { TenantNoAccessPage }
