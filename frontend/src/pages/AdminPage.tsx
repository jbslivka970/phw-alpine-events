import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { adminApi } from '../api/admin'
import type { AdminUser, AppRoleAvailable, UserRoleAssignment, UserRoleAssignmentsResponse } from '../api/admin'
import { eventsApi } from '../api/events'
import { groupsApi } from '../api/groups'
import { membersApi } from '../api/members'
import LoadingSkeleton from '../components/LoadingSkeleton'
import type { EventRecord } from '../api/events'
import { toUserErrorMessage } from '../utils/errorMessage'

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

function formatRoleManagementError(error: unknown, fallback: string): string {
  const message = toUserErrorMessage(error, fallback);
  const withoutRawGraphJson = message.replace(/\{\s*"error"\s*:\s*\{[\s\S]*$/i, '').trim();

  if (/Authorization_RequestDenied|Insufficient privileges|\(403\)/i.test(message)) {
    return 'Role management is not authorized yet. Grant Microsoft Graph Application permissions to the provisioning app: Application.Read.All, User.Read.All, and AppRoleAssignment.ReadWrite.All, then Grant admin consent. You can assign roles manually in Azure Portal until this is configured.';
  }

  return withoutRawGraphJson || fallback;
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
  const [retentionPreviewBusy, setRetentionPreviewBusy] = useState(false)
  const [retentionPreviewError, setRetentionPreviewError] = useState<string | null>(null)
  const [retentionPreviewGeneratedAt, setRetentionPreviewGeneratedAt] = useState<string | null>(null)
  const [retentionNotificationDays, setRetentionNotificationDays] = useState('180')
  const [retentionInboundSmsDays, setRetentionInboundSmsDays] = useState('365')
  const [retentionEmailPrefDays, setRetentionEmailPrefDays] = useState('365')
  const [retentionPreviewRows, setRetentionPreviewRows] = useState<Array<{ target: string; retentionDays: number; affectedRows: number }>>([])
  const [supportRelayLoading, setSupportRelayLoading] = useState(true)
  const [supportRelaySaving, setSupportRelaySaving] = useState(false)
  const [supportRelayError, setSupportRelayError] = useState<string | null>(null)
  const [supportRelaySuccess, setSupportRelaySuccess] = useState<string | null>(null)
  const [supportInboxEmail, setSupportInboxEmail] = useState('support@phwcoloradoalpine.org')
  const [supportRelayRecipientsRaw, setSupportRelayRecipientsRaw] = useState('')
  const [supportRelayEnabled, setSupportRelayEnabled] = useState(false)
  const [supportRelayUpdatedAt, setSupportRelayUpdatedAt] = useState<string | null>(null)
  const [supportRelayUpdatedBy, setSupportRelayUpdatedBy] = useState<string | null>(null)
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([])
  const [adminUsersLoading, setAdminUsersLoading] = useState(true)
  const [adminUsersError, setAdminUsersError] = useState<string | null>(null)
  const [deletingUserId, setDeletingUserId] = useState<string | null>(null)
  const [roleEmail, setRoleEmail] = useState('')
  const [roleLookupBusy, setRoleLookupBusy] = useState(false)
  const [roleLookupError, setRoleLookupError] = useState<string | null>(null)
  const [roleLookupResult, setRoleLookupResult] = useState<UserRoleAssignmentsResponse | null>(null)
  const [availableRoles, setAvailableRoles] = useState<AppRoleAvailable[]>([])
  const [selectedNewRole, setSelectedNewRole] = useState('')
  const [roleAssignBusy, setRoleAssignBusy] = useState(false)
  const [roleAssignError, setRoleAssignError] = useState<string | null>(null)
  const [roleRemovingId, setRoleRemovingId] = useState<string | null>(null)

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
    setAdminUsersLoading(true)
    setAdminUsersError(null)

    adminApi.listAdminUsers({ page: 1, pageSize: 200 })
      .then((response) => {
        if (!active) return
        setAdminUsers(response.data)
      })
      .catch((error) => {
        if (!active) return
        setAdminUsersError(toUserErrorMessage(error, 'Failed to load admin users.'))
      })
      .finally(() => {
        if (active) setAdminUsersLoading(false)
      })

    return () => { active = false }
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

  useEffect(() => {
    let active = true
    setSupportRelayLoading(true)
    adminApi.getSupportEmailRelayConfig()
      .then((config) => {
        if (!active) return
        setSupportInboxEmail(config.supportInboxEmail)
        setSupportRelayRecipientsRaw(config.relayRecipients.join(', '))
        setSupportRelayEnabled(config.enabled)
        setSupportRelayUpdatedAt(config.updatedAt)
        setSupportRelayUpdatedBy(config.updatedBy)
      })
      .catch((error) => {
        if (!active) return
        setSupportRelayError(toUserErrorMessage(error, 'Failed to load support relay configuration.'))
      })
      .finally(() => {
        if (active) setSupportRelayLoading(false)
      })

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
      setInviteError(toUserErrorMessage(error, 'Failed to generate invite draft.'))
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
      setInviteApplyError(toUserErrorMessage(error, 'Failed to apply invite draft to templates.'))
    } finally {
      setIsApplyingInvite(false)
    }
  }

  async function handleRetentionPreview() {
    setRetentionPreviewBusy(true)
    setRetentionPreviewError(null)
    try {
      const parseDays = (value: string) => {
        const parsed = Number.parseInt(value, 10)
        return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
      }

      const response = await adminApi.previewRetention({
        notification_log_days: parseDays(retentionNotificationDays),
        inbound_sms_log_days: parseDays(retentionInboundSmsDays),
        email_preference_log_days: parseDays(retentionEmailPrefDays),
      })

      setRetentionPreviewGeneratedAt(response.generated_at)
      setRetentionPreviewRows(response.results.map((row) => ({
        target: row.target,
        retentionDays: row.retentionDays,
        affectedRows: row.affectedRows,
      })))
    } catch (error) {
      setRetentionPreviewError(toUserErrorMessage(error, 'Failed to preview retention results.'))
    } finally {
      setRetentionPreviewBusy(false)
    }
  }

  async function handleSaveSupportRelayConfig() {
    setSupportRelaySaving(true)
    setSupportRelayError(null)
    setSupportRelaySuccess(null)

    try {
      const relayTo = supportRelayRecipientsRaw
        .split(',')
        .map((value) => value.trim())
        .filter((value, index, list) => value.length > 0 && list.indexOf(value) === index)

      const config = await adminApi.updateSupportEmailRelayConfig({
        support_inbox_email: supportInboxEmail.trim() || 'support@phwcoloradoalpine.org',
        relay_to: relayTo,
        enabled: supportRelayEnabled,
      })

      setSupportInboxEmail(config.supportInboxEmail)
      setSupportRelayRecipientsRaw(config.relayRecipients.join(', '))
      setSupportRelayEnabled(config.enabled)
      setSupportRelayUpdatedAt(config.updatedAt)
      setSupportRelayUpdatedBy(config.updatedBy)
      setSupportRelaySuccess('Support relay configuration saved.')
    } catch (error) {
      setSupportRelayError(toUserErrorMessage(error, 'Failed to save support relay configuration.'))
    } finally {
      setSupportRelaySaving(false)
    }
  }

  async function handleRoleLookup() {
    if (!roleEmail.trim()) return
    setRoleLookupBusy(true)
    setRoleLookupError(null)
    setRoleLookupResult(null)
    setRoleAssignError(null)
    try {
      const [rolesResp, availResp] = await Promise.all([
        adminApi.getUserRoleAssignments(roleEmail.trim()),
        adminApi.listAvailableAppRoles(),
      ])
      setRoleLookupResult(rolesResp)
      setAvailableRoles(availResp.roles)
      setSelectedNewRole(availResp.roles[0]?.value ?? '')
    } catch (error) {
      setRoleLookupError(formatRoleManagementError(error, 'Failed to look up user roles.'))
    } finally {
      setRoleLookupBusy(false)
    }
  }

  async function handleAssignRole() {
    if (!roleLookupResult || !selectedNewRole) return
    setRoleAssignBusy(true)
    setRoleAssignError(null)
    try {
      const newAssignment = await adminApi.assignAppRole(roleLookupResult.email, selectedNewRole)
      setRoleLookupResult((prev) =>
        prev ? { ...prev, assignments: [...prev.assignments, newAssignment] } : prev,
      )
    } catch (error) {
      setRoleAssignError(formatRoleManagementError(error, 'Failed to assign role.'))
    } finally {
      setRoleAssignBusy(false)
    }
  }

  async function handleRemoveRole(assignment: UserRoleAssignment) {
    setRoleRemovingId(assignment.assignmentId)
    setRoleAssignError(null)
    try {
      await adminApi.removeAppRole(assignment.assignmentId)
      setRoleLookupResult((prev) =>
        prev
          ? { ...prev, assignments: prev.assignments.filter((a) => a.assignmentId !== assignment.assignmentId) }
          : prev,
      )
    } catch (error) {
      setRoleAssignError(formatRoleManagementError(error, 'Failed to remove role.'))
    } finally {
      setRoleRemovingId(null)
    }
  }

  async function handleDeleteAdminUser(user: AdminUser) {
    const confirmed = window.confirm(`Delete admin user ${user.email}? This cannot be undone.`)
    if (!confirmed) return

    setDeletingUserId(user.user_id)
    setAdminUsersError(null)
    try {
      await adminApi.deleteAdminUser(user.user_id)
      setAdminUsers((current) => current.filter((row) => row.user_id !== user.user_id))
    } catch (error) {
      setAdminUsersError(toUserErrorMessage(error, 'Failed to delete admin user.'))
    } finally {
      setDeletingUserId(null)
    }
  }

  const provider = inviteDraft?.provider ?? null
  const providerHint =
    provider === 'azure-openai'
      ? 'Draft generated with Azure OpenAI.'
      : provider === 'openai'
      ? 'Draft generated with OpenAI compatibility mode.'
      : provider === 'fallback'
      ? 'AI response unavailable. Deterministic fallback copy was used.'
      : null

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
      <p className="page-subtitle">Program system health, configuration status, and administration overview.</p>

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

        {/* Program Stats */}
        <section className="card admin-stats-card">
          <h2 className="admin-section-title">Program at a Glance</h2>
          {statsLoading ? (
            <div className="phw-skeleton-grid">
              <LoadingSkeleton lines={2} compact />
              <LoadingSkeleton lines={2} compact />
              <LoadingSkeleton lines={2} compact />
            </div>
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
                <td><code>TavfCreator</code></td>
                <td>Guide-eligible; allows TAVF posting creation even with Admin role</td>
              </tr>
              <tr>
                <td><code>User</code></td>
                <td>View events, submit RSVPs, view TAVF listings</td>
              </tr>
            </tbody>
          </table>
        </section>

          {/* App Role Assignment */}
          <section className="card admin-tools-card">
            <h2 className="admin-section-title">App Role Assignment</h2>
            <p className="page-subtitle" style={{ marginBottom: '0.9rem' }}>
              Assign or remove Azure app roles for any user. Changes take effect after the user signs out and back in. Requires
              {' '}<code>ENTRA_PROVISIONING_*</code>{' '}environment variables and Graph application permissions:
              {' '}<code>Application.Read.All</code>, <code>User.Read.All</code>, and <code>AppRoleAssignment.ReadWrite.All</code>.
            </p>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <input
                className="members-input"
                style={{ flex: 1 }}
                type="email"
                placeholder="User email address"
                value={roleEmail}
                onChange={(e) => setRoleEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleRoleLookup() }}
                disabled={roleLookupBusy}
              />
              <button
                className="btn btn--outline btn--sm"
                disabled={roleLookupBusy || !roleEmail.trim()}
                onClick={() => void handleRoleLookup()}
              >
                {roleLookupBusy ? 'Looking up…' : 'Look Up'}
              </button>
            </div>

            {roleLookupError && (
              <p className="ui-notice ui-notice--error" style={{ overflowWrap: 'anywhere' }}>
                {roleLookupError}
              </p>
            )}

            {roleLookupResult && (
              <div style={{ marginTop: 12 }}>
                <p style={{ marginBottom: 8 }}>
                  <strong>{roleLookupResult.email}</strong> — current roles:
                </p>
                {roleLookupResult.assignments.length === 0 ? (
                  <p className="page-subtitle">No app role assignments found.</p>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                    {roleLookupResult.assignments.map((a) => (
                      <span
                        key={a.assignmentId}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          background: '#e8f0fe',
                          border: '1px solid #aac4f6',
                          borderRadius: 6,
                          padding: '3px 10px',
                          fontSize: '0.85rem',
                        }}
                      >
                        <code>{a.roleName}</code>
                        <button
                          aria-label={`Remove ${a.roleName}`}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, lineHeight: 1, color: '#c0392b' }}
                          disabled={roleRemovingId === a.assignmentId}
                          onClick={() => void handleRemoveRole(a)}
                        >
                          {roleRemovingId === a.assignmentId ? '…' : '✕'}
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {availableRoles.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <select
                      className="members-input"
                      value={selectedNewRole}
                      onChange={(e) => setSelectedNewRole(e.target.value)}
                      disabled={roleAssignBusy}
                    >
                      {availableRoles.map((r) => (
                        <option key={r.id} value={r.value}>{r.displayName} ({r.value})</option>
                      ))}
                    </select>
                    <button
                      className="btn btn--primary btn--sm"
                      disabled={roleAssignBusy || !selectedNewRole}
                      onClick={() => void handleAssignRole()}
                    >
                      {roleAssignBusy ? 'Assigning…' : 'Assign Role'}
                    </button>
                  </div>
                )}

                {roleAssignError && (
                  <p className="ui-notice ui-notice--error" style={{ marginTop: 8, overflowWrap: 'anywhere' }}>
                    {roleAssignError}
                  </p>
                )}

                <p className="page-subtitle" style={{ marginTop: 10, fontSize: '0.8rem' }}>
                  Role changes require the user to sign out and sign back in before the new token reflects the updated role.
                </p>
              </div>
            )}
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
          <h2 className="admin-section-title">Admin Users</h2>
          <p className="page-subtitle" style={{ marginBottom: '0.9rem' }}>
            Manage admin portal user records. Deleting here removes access metadata in the app database.
          </p>

          {adminUsersLoading && <LoadingSkeleton lines={4} compact />}
          {adminUsersError && <p className="ui-notice ui-notice--error">{adminUsersError}</p>}

          {!adminUsersLoading && !adminUsersError && (
            <table className="members-table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {adminUsers.map((user) => (
                  <tr key={user.user_id}>
                    <td>{user.email}</td>
                    <td>{user.role}</td>
                    <td>{user.is_active ? 'active' : 'inactive'}</td>
                    <td>
                      <button
                        className="btn btn--outline btn--sm"
                        disabled={deletingUserId === user.user_id}
                        onClick={() => void handleDeleteAdminUser(user)}
                      >
                        {deletingUserId === user.user_id ? 'Deleting…' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
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
          <div className="admin-ai-status">
            {isGeneratingInvite && <span className="admin-ai-status__text">Generating draft and validating structured response…</span>}
            {provider && <span className={`provider-chip provider-chip--${provider}`}>{provider}</span>}
            {providerHint && <span className="admin-ai-status__text">{providerHint}</span>}
          </div>
          {inviteError && <p className="ui-notice ui-notice--error">{inviteError}</p>}
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
              {inviteDraft.provider === 'fallback' && (
                <p className="ui-notice ui-notice--info" style={{ margin: 0 }}>
                  Fallback content is safe to use, but you can retry now that Azure OpenAI is configured.
                </p>
              )}

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
                <div className="admin-ai-actions">
                  <button
                    className="btn btn--secondary btn--sm"
                    disabled={isApplyingInvite || !inviteReviewed}
                    onClick={() => void handleApplyInviteDraft()}
                  >
                    {isApplyingInvite ? 'Applying…' : 'Apply Draft To Templates'}
                  </button>
                  <button
                    className="btn btn--outline btn--sm"
                    disabled={isGeneratingInvite}
                    onClick={() => void handleGenerateInviteDraft()}
                  >
                    Retry Draft
                  </button>
                </div>
                {inviteApplyError && <p className="ui-notice ui-notice--error">{inviteApplyError}</p>}
                {inviteApplySuccess && <p className="ui-notice ui-notice--success">{inviteApplySuccess}</p>}
              </div>
            </div>
          )}
        </section>

        <section className="card admin-tools-card">
          <h2 className="admin-section-title">Support Email Relay</h2>
          <p className="page-subtitle" style={{ marginBottom: '0.9rem' }}>
            Inbound mail sent to the support inbox is relayed to configured support contacts.
          </p>

          <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
            <input
              className="members-input"
              value={supportInboxEmail}
              onChange={(e) => setSupportInboxEmail(e.target.value)}
              placeholder="Support inbox address"
            />
            <textarea
              className="members-input"
              rows={3}
              value={supportRelayRecipientsRaw}
              onChange={(e) => setSupportRelayRecipientsRaw(e.target.value)}
              placeholder="Relay recipients (comma-separated emails)"
            />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={supportRelayEnabled}
                onChange={(e) => setSupportRelayEnabled(e.target.checked)}
              />
              Enable support relay forwarding
            </label>
          </div>

          <button className="btn btn--primary btn--sm" disabled={supportRelayLoading || supportRelaySaving} onClick={() => void handleSaveSupportRelayConfig()}>
            {supportRelaySaving ? 'Saving…' : 'Save Support Relay'}
          </button>

          {supportRelayLoading && <p className="page-subtitle" style={{ marginTop: 10 }}>Loading support relay settings…</p>}
          {supportRelayError && <p className="ui-notice ui-notice--error" style={{ marginTop: 10 }}>{supportRelayError}</p>}
          {supportRelaySuccess && <p className="ui-notice ui-notice--success" style={{ marginTop: 10 }}>{supportRelaySuccess}</p>}
          {(supportRelayUpdatedAt || supportRelayUpdatedBy) && (
            <small style={{ color: 'var(--muted)', display: 'block', marginTop: 10 }}>
              Last updated{supportRelayUpdatedBy ? ` by ${supportRelayUpdatedBy}` : ''}{supportRelayUpdatedAt ? ` at ${new Date(supportRelayUpdatedAt).toLocaleString()}` : ''}
            </small>
          )}
        </section>

        <section className="card admin-tools-card">
          <h2 className="admin-section-title">Retention Dry-Run Preview</h2>
          <p className="page-subtitle" style={{ marginBottom: '0.9rem' }}>
            Preview candidate row counts before enabling retention delete mode in production.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 8, marginBottom: 10 }}>
            <input
              className="members-input"
              value={retentionNotificationDays}
              onChange={(e) => setRetentionNotificationDays(e.target.value)}
              placeholder="notification_log days"
            />
            <input
              className="members-input"
              value={retentionInboundSmsDays}
              onChange={(e) => setRetentionInboundSmsDays(e.target.value)}
              placeholder="inbound_sms_log days"
            />
            <input
              className="members-input"
              value={retentionEmailPrefDays}
              onChange={(e) => setRetentionEmailPrefDays(e.target.value)}
              placeholder="email_preference_log days"
            />
          </div>

          <button className="btn btn--primary btn--sm" disabled={retentionPreviewBusy} onClick={() => void handleRetentionPreview()}>
            {retentionPreviewBusy ? 'Running Preview…' : 'Run Retention Preview'}
          </button>

          {retentionPreviewError && <p className="ui-notice ui-notice--error" style={{ marginTop: 10 }}>{retentionPreviewError}</p>}
          {retentionPreviewGeneratedAt && (
            <small style={{ color: 'var(--muted)', display: 'block', marginTop: 10 }}>
              Generated: {new Date(retentionPreviewGeneratedAt).toLocaleString()}
            </small>
          )}

          {retentionPreviewRows.length > 0 && (
            <table className="members-table" style={{ marginTop: 10 }}>
              <thead>
                <tr>
                  <th>Target</th>
                  <th>Retention Days</th>
                  <th>Candidate Rows</th>
                </tr>
              </thead>
              <tbody>
                {retentionPreviewRows.map((row) => (
                  <tr key={row.target}>
                    <td>{row.target}</td>
                    <td>{row.retentionDays}</td>
                    <td>{row.affectedRows.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

      </div>
    </div>
  )
}

export { AdminPage }