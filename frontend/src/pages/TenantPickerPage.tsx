import { useMemo } from 'react'
import { useTenantContext } from '../contexts/TenantContext'

function formatExpiry(value: string | null): string | null {
  if (!value) {
    return null
  }

  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) {
    return null
  }

  return new Date(timestamp).toLocaleString()
}

function TenantPickerPage() {
  const { tenants, activeTenant, selectTenant } = useTenantContext()

  const sortedTenants = useMemo(() => {
    return [...tenants].sort((a, b) => a.display_name.localeCompare(b.display_name))
  }, [tenants])

  return (
    <section className="page" style={{ maxWidth: 920, margin: '0 auto' }}>
      <h1>Select a Program</h1>
      <p className="events-subtitle">
        Choose which tenant context to use for this session.
      </p>

      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        {sortedTenants.map((tenant) => {
          const isActive = activeTenant?.tenant_id === tenant.tenant_id
          const expiry = formatExpiry(tenant.expires_at)

          return (
            <article key={tenant.tenant_id} className="card" style={{ borderColor: isActive ? '#1f5f4a' : undefined }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <h2 style={{ margin: 0 }}>{tenant.display_name}</h2>
                {tenant.is_demo ? (
                  <span style={{
                    borderRadius: 999,
                    border: '1px solid #f59e0b',
                    color: '#92400e',
                    fontSize: 12,
                    fontWeight: 600,
                    padding: '2px 8px',
                  }}>
                    Demo
                  </span>
                ) : null}
              </div>

              <p style={{ marginTop: 8, color: '#475569' }}>
                Role: {tenant.role.replaceAll('_', ' ')}
              </p>

              {expiry ? (
                <p style={{ marginTop: 8, color: '#92400e' }}>
                  Access expires: {expiry}
                </p>
              ) : null}

              <button
                type="button"
                className="btn btn--primary"
                style={{ marginTop: 12 }}
                onClick={() => selectTenant(tenant.tenant_id)}
              >
                {isActive ? 'Selected' : 'Use this tenant'}
              </button>
            </article>
          )
        })}
      </div>
    </section>
  )
}

export { TenantPickerPage }
