import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminApi } from '../api/admin'
import { eventsApi } from '../api/events'
import { groupsApi } from '../api/groups'
import { membersApi } from '../api/members'
import type { EventRecord } from '../api/events'

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
  const [events, setEvents] = useState<EventRecord[]>([])
  const [selectedEventId, setSelectedEventId] = useState<string>('')
  const [inviteTone, setInviteTone] = useState<'friendly' | 'professional'>('friendly')
  const [isGeneratingInvite, setIsGeneratingInvite] = useState(false)
  const [isApplyingInvite, setIsApplyingInvite] = useState(false)
  const [inviteDraft, setInviteDraft] = useState<{ subject: string; emailBody: string; smsBody: string; provider: string } | null>(null)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [inviteApplyError, setInviteApplyError] = useState<string | null>(null)
  const [inviteApplySuccess, setInviteApplySuccess] = useState<string | null>(null)
  const [inviteTemplateName, setInviteTemplateName] = useState('Event Invite')
  const [inviteReviewed, setInviteReviewed] = useState(false)
  const [inviteReviewNote, setInviteReviewNote] = useState('')

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
        setEvents(events)
        if (events.length > 0) {
          setSelectedEventId((current) => current || events[0].event_id)
        }
        setStats({ members: memRes.total, groups: grps.length, eventsThisYear })
      })
      .catch(() => {})
      .finally(() => { if (active) setStatsLoading(false) })
    return () => { active = false }
  }, [])

  async function handleGenerateInviteDraft() {
    if (!selectedEventId) {
      setInviteError('Select an event first.')
      return
    }

    setIsGeneratingInvite(true)
    setInviteError(null)
    setInviteApplyError(null)
    setInviteApplySuccess(null)
    try {
      const draft = await adminApi.generateInviteDraft({
        event_id: selectedEventId,
        tone: inviteTone,
      })
      setInviteDraft(draft)
    } catch (error) {
      setInviteError(error instanceof Error ? error.message : 'Failed to generate invite draft.')
    } finally {
      setIsGeneratingInvite(false)
    }
  }

  async function handleApplyInviteDraft() {
    if (!inviteDraft) {
      setInviteApplyError('Generate a draft first.')
      return
    }
    if (!selectedEventId) {
      setInviteApplyError('Select an event before applying templates.')
      return
    }
    if (!inviteReviewed) {
      setInviteApplyError('Review and confirm the draft before applying.')
      return
    }

    setIsApplyingInvite(true)
    setInviteApplyError(null)
    setInviteApplySuccess(null)
    try {
      const response = await adminApi.applyInviteDraftToTemplates({
        event_id: selectedEventId,
        tone: inviteTone,
        template_name: inviteTemplateName.trim() || 'Event Invite',
        approved: true,
        review_note: inviteReviewNote.trim() || undefined,
      })
      setInviteApplySuccess(`Applied to ${response.template_name} (email + sms) at ${new Date(response.applied_at).toLocaleString()}.`)
    } catch (error) {
      setInviteApplyError(error instanceof Error ? error.message : 'Failed to apply invite draft to templates.')
    } finally {
      setIsApplyingInvite(false)
    }
  }

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

        <section className="card admin-tools-card">
          <h2 className="admin-section-title">AI Invite Draft</h2>
          <p className="page-subtitle" style={{ marginBottom: '0.9rem' }}>
            Generate an invite draft from an event record. Uses AI when configured and falls back to deterministic copy.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10, marginBottom: 10 }}>
            <select
              className="members-input"
              value={selectedEventId}
              onChange={(e) => setSelectedEventId(e.target.value)}
            >
              {events.length === 0 ? (
                <option value="">No events available</option>
              ) : events.map((event) => (
                <option key={event.event_id} value={event.event_id}>{event.title}</option>
              ))}
            </select>
            <select
              className="members-input"
              value={inviteTone}
              onChange={(e) => setInviteTone(e.target.value as 'friendly' | 'professional')}
            >
              <option value="friendly">Friendly</option>
              <option value="professional">Professional</option>
            </select>
          </div>
          <button className="btn btn--primary btn--sm" disabled={isGeneratingInvite} onClick={() => void handleGenerateInviteDraft()}>
            {isGeneratingInvite ? 'Generating…' : 'Generate Invite Draft'}
          </button>
          {inviteError && <p className="members-error" style={{ marginTop: 10 }}>{inviteError}</p>}
          {inviteDraft && (
            <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
              <div>
                <strong>Subject</strong>
                <div className="members-input" style={{ whiteSpace: 'pre-wrap' }}>{inviteDraft.subject}</div>
              </div>
              <div>
                <strong>Email Body</strong>
                <textarea className="members-input" rows={7} readOnly value={inviteDraft.emailBody} />
              </div>
              <div>
                <strong>SMS Body</strong>
                <textarea className="members-input" rows={3} readOnly value={inviteDraft.smsBody} />
              </div>
              <small style={{ color: 'var(--muted)' }}>Provider: {inviteDraft.provider}</small>

              <div style={{ display: 'grid', gap: 8, marginTop: 6 }}>
                <input
                  className="members-input"
                  value={inviteTemplateName}
                  onChange={(e) => setInviteTemplateName(e.target.value)}
                  placeholder="Template name"
                />
                <textarea
                  className="members-input"
                  rows={2}
                  value={inviteReviewNote}
                  onChange={(e) => setInviteReviewNote(e.target.value)}
                  placeholder="Review note (optional)"
                />
                <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={inviteReviewed}
                    onChange={(e) => setInviteReviewed(e.target.checked)}
                  />
                  I reviewed this draft and approve applying it to active templates.
                </label>
                <button
                  className="btn btn--secondary btn--sm"
                  disabled={isApplyingInvite || !inviteReviewed}
                  onClick={() => void handleApplyInviteDraft()}
                >
                  {isApplyingInvite ? 'Applying…' : 'Apply Draft To Templates'}
                </button>
                {inviteApplyError && <p className="members-error">{inviteApplyError}</p>}
                {inviteApplySuccess && <p style={{ color: '#1a7f37', margin: 0 }}>{inviteApplySuccess}</p>}
              </div>
            </div>
          )}
        </section>

      </div>
    </div>
  )
}

export { AdminPage }