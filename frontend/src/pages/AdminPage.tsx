import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { eventsApi } from '../api/events'
import { groupsApi } from '../api/groups'
import { membersApi } from '../api/members'

type HealthState = 'loading' | 'ok' | 'error' | 'unconfigured'

interface HealthStatus {
  api: HealthState
  db: HealthState
  notifications: HealthState
  nodeEnv: string
  nodeVersion: string
}

function StatusDot({ status }: { status: HealthState }) {
  const colour: Record<HealthState, string> = {
    ok: '#27ae60',
    error: '#c0392b',
    loading: '#aaa',
    unconfigured: '#e0a800',
  }
  return (
    <span
      className="admin-status-dot"
      style={{ background: colour[status] }}
      aria-hidden="true"
    />
  )
}

function AdminPage() {
  const [health, setHealth] = useState<HealthStatus>({
    api: 'loading',
    db: 'loading',
    notifications: 'loading',
    nodeEnv: '—',
    nodeVersion: '—',
  })
  const [stats, setStats] = useState({ members: 0, groups: 0, eventsThisYear: 0 })
  const [statsLoading, setStatsLoading] = useState(true)

  useEffect(() => {
    const rawBase = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api/v1'
    const base = rawBase.endsWith('/') ? rawBase.slice(0, -1) : rawBase

    fetch(`${base}/health`)
      .then((r) => (r.ok ? setHealth((h) => ({ ...h, api: 'ok' })) : Promise.reject()))
      .catch(() => setHealth((h) => ({ ...h, api: 'error' })))

    fetch(`${base}/health/ready`)
      .then((r) => (r.ok ? setHealth((h) => ({ ...h, db: 'ok' })) : Promise.reject()))
      .catch(() => setHealth((h) => ({ ...h, db: 'error' })))

    fetch(`${base}/health/startup`)
      .then((r) => r.json())
      .then((data: { checks?: { notificationsConfigured?: boolean }; runtime?: { nodeEnv?: string; nodeVersion?: string } }) => {
        setHealth((h) => ({
          ...h,
          notifications: data?.checks?.notificationsConfigured ? 'ok' : 'unconfigured',
          nodeEnv: data?.runtime?.nodeEnv ?? '—',
          nodeVersion: data?.runtime?.nodeVersion ?? '—',
        }))
      })
      .catch(() => setHealth((h) => ({ ...h, notifications: 'error' })))
  }, [])

  useEffect(() => {
    let active = true
    setStatsLoading(true)
    Promise.all([
      membersApi.list({ page: 1, pageSize: 1, isActive: true }),
      groupsApi.list(),
      eventsApi.list(),
    ])
      .then(([memRes, grps, events]) => {
        if (!active) return
        const thisYear = new Date().getFullYear()
        const eventsThisYear = events.filter(
          (e) => new Date(e.event_date).getFullYear() === thisYear,
        ).length
        setStats({ members: memRes.total, groups: grps.length, eventsThisYear })
      })
      .catch(() => {})
      .finally(() => { if (active) setStatsLoading(false) })
    return () => { active = false }
  }, [])

  const healthRows: Array<{ label: string; status: HealthState; value: string }> = [
    {
      label: 'API process',
      status: health.api,
      value: health.api === 'loading' ? 'Checking…' : health.api === 'ok' ? 'Online' : 'Offline',
    },
    {
      label: 'Database',
      status: health.db,
      value: health.db === 'loading' ? 'Checking…' : health.db === 'ok' ? 'Connected' : 'Unavailable',
    },
    {
      label: 'Notifications (ACS)',
      status: health.notifications,
      value:
        health.notifications === 'loading'
          ? 'Checking…'
          : health.notifications === 'ok'
          ? 'Configured'
          : health.notifications === 'unconfigured'
          ? 'Not configured'
          : 'Error',
    },
  ]

  const tools = [
    { to: '/members', icon: '👥', title: 'Members', desc: 'Search, edit, and manage member records' },
    { to: '/groups', icon: '🏷️', title: 'Groups', desc: 'Create and assign notification groups' },
    { to: '/import', icon: '📥', title: 'CSV Import', desc: 'Bulk import member records from CSV' },
    { to: '/reports', icon: '📊', title: 'Reports', desc: 'Event attendance and participation reports' },
  ]

  return (
    <div className="page">
      <h1 className="page-title">Admin</h1>
      <p className="page-subtitle">Chapter system health, configuration status, and administration overview.</p>

      <div className="admin-grid">

        {/* System Health */}
        <section className="card admin-health-card">
          <h2 className="admin-section-title">System Health</h2>
          <div className="admin-health-rows">
            {healthRows.map((row) => (
              <div key={row.label} className="admin-health-row">
                <span className="admin-health-label">
                  <StatusDot status={row.status} />
                  {row.label}
                </span>
                <span className="admin-health-value">{row.value}</span>
              </div>
            ))}
            <div className="admin-health-row admin-health-row--meta">
              <span className="admin-health-label">Environment</span>
              <span className="admin-health-value">{health.nodeEnv}</span>
            </div>
            <div className="admin-health-row admin-health-row--meta">
              <span className="admin-health-label">Node.js</span>
              <span className="admin-health-value">{health.nodeVersion}</span>
            </div>
          </div>
        </section>

        {/* Chapter Stats */}
        <section className="card admin-stats-card">
          <h2 className="admin-section-title">Chapter at a Glance</h2>
          {statsLoading ? (
            <p className="members-loading">Loading stats…</p>
          ) : (
            <div className="stat-grid" style={{ marginBottom: 0 }}>
              <div className="stat-card">
                <span className="stat-value">{stats.members.toLocaleString()}</span>
                <span className="stat-label">Active Members</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">{stats.groups}</span>
                <span className="stat-label">Groups</span>
              </div>
              <div className="stat-card">
                <span className="stat-value">{stats.eventsThisYear}</span>
                <span className="stat-label">Events This Year</span>
              </div>
            </div>
          )}
        </section>

        {/* Role Guide */}
        <section className="card admin-roles-card">
          <h2 className="admin-section-title">Role Management</h2>
          <p className="page-subtitle" style={{ marginBottom: '0.9rem' }}>
            App roles are assigned in <strong>Azure External ID (CIAM)</strong> via the Azure portal.
            Navigate to: <em>Azure Portal → External Identities → App registrations → your app → App roles &amp; assignments</em>.
          </p>
          <table className="members-table">
            <thead>
              <tr><th>Role</th><th>Access</th></tr>
            </thead>
            <tbody>
              <tr>
                <td><code>Admin</code></td>
                <td>Full access — members, import, reports, groups, admin</td>
              </tr>
              <tr>
                <td><code>EventCreator</code></td>
                <td>Create and manage events, TAVF postings</td>
              </tr>
              <tr>
                <td><code>User</code></td>
                <td>View events, submit RSVPs, view TAVF listings</td>
              </tr>
            </tbody>
          </table>
        </section>

        {/* Quick Tools */}
        <section className="card admin-tools-card">
          <h2 className="admin-section-title">Admin Tools</h2>
          <div className="admin-tools-list">
            {tools.map((t) => (
              <Link key={t.to} to={t.to} className="admin-tool-link">
                <span className="admin-tool-icon">{t.icon}</span>
                <div>
                  <strong>{t.title}</strong>
                  <br />
                  <small>{t.desc}</small>
                </div>
              </Link>
            ))}
          </div>
        </section>

      </div>
    </div>
  )
}

export { AdminPage }