import { FormEvent, useEffect, useMemo, useState } from 'react'
import { membersApi } from '../api/members'
import type { MemberRecord } from '../api/members'
import { useAuth } from '../hooks/useAuth'

interface MemberEditState {
  first_name: string
  last_name: string
  email: string
  mobile_phone: string
  sms_opt_in: boolean
  email_opt_out: boolean
  is_active: boolean
}

function toEditState(m: MemberRecord): MemberEditState {
  return {
    first_name: m.first_name,
    last_name: m.last_name,
    email: m.email,
    mobile_phone: m.mobile_phone ?? '',
    sms_opt_in: m.sms_opt_in,
    email_opt_out: m.email_opt_out,
    is_active: m.is_active,
  }
}

function MembersPage() {
  const { isAdmin } = useAuth()
  const [search, setSearch] = useState('')
  const [members, setMembers] = useState<MemberRecord[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<MemberRecord | null>(null)
  const [edit, setEdit] = useState<MemberEditState | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [consentLog, setConsentLog] = useState<Array<{
    consent_log_id: string
    action: string
    source: string
    recorded_at: string
    notes: string | null
  }>>([])

  const totalLabel = useMemo(
    () => `${members.length} member${members.length === 1 ? '' : 's'}`,
    [members.length],
  )

  useEffect(() => {
    let active = true
    setIsLoading(true)
    setError(null)
    membersApi
      .list({ page: 1, pageSize: 100, search: search || undefined, isActive: true })
      .then((r) => { if (active) setMembers(r.data) })
      .catch((e: unknown) => { if (active) setError(e instanceof Error ? e.message : 'Failed to load') })
      .finally(() => { if (active) setIsLoading(false) })
    return () => { active = false }
  }, [search])

  function startEdit(m: MemberRecord) {
    setSelected(m)
    setEdit(toEditState(m))
    if (isAdmin()) {
      membersApi.consentLog(m.member_id)
        .then(setConsentLog)
        .catch(() => setConsentLog([]))
    } else {
      setConsentLog([])
    }
  }

  function closeEditor() {
    setSelected(null)
    setEdit(null)
    setError(null)
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (!selected || !edit) return
    setIsSaving(true)
    setError(null)
    try {
      const updated = await membersApi.update(selected.member_id, {
        ...edit,
        mobile_phone: edit.mobile_phone || null,
      })
      setMembers((cur) => cur.map((m) => (m.member_id === updated.member_id ? updated : m)))
      closeEditor()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSmsToggle(memberId: string, smsOptIn: boolean) {
    try {
      const updated = await membersApi.updateSmsConsent(memberId, smsOptIn)
      setMembers((cur) => cur.map((m) => (m.member_id === updated.member_id ? updated : m)))
      if (selected?.member_id === memberId) {
        setSelected(updated)
        setEdit(toEditState(updated))
        if (isAdmin()) {
          const logs = await membersApi.consentLog(memberId)
          setConsentLog(logs)
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'SMS consent update failed')
    }
  }

  return (
    <div className="page">
      <h1 className="page__title">Members</h1>
      <p className="page__subtitle">Search, review, and edit active member records.</p>

      <section className="members-toolbar card">
        <label className="members-search-label" htmlFor="member-search">Search</label>
        <input
          id="member-search"
          className="members-input"
          placeholder="Name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className="members-count">{totalLabel}</span>
      </section>

      {error && <p className="members-error">{error}</p>}

      <section className="card members-table-wrap">
        {isLoading ? (
          <p className="members-loading">Loading members...</p>
        ) : (
          <table className="members-table">
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>Phone</th><th>SMS</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.member_id}>
                  <td>{m.first_name} {m.last_name}</td>
                  <td>{m.email}</td>
                  <td>{m.mobile_phone ?? '-'}</td>
                  <td>{m.sms_opt_in ? 'Opted in' : 'Opted out'}</td>
                  <td>{m.is_active ? 'Active' : 'Inactive'}</td>
                  <td><button className="btn btn--primary btn--sm" onClick={() => startEdit(m)}>Edit</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {selected && edit && (
        <div className="modal-overlay" role="presentation" onClick={closeEditor}>
          <section className="modal" role="dialog" aria-modal="true" aria-label="Edit member" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <h2 className="modal__title">Edit member</h2>
              <button className="btn btn--outline btn--sm" type="button" onClick={closeEditor}>Close</button>
            </div>
            <div className="modal__body">
              <form className="members-form" onSubmit={handleSave}>
                <input className="members-input" value={edit.first_name} onChange={(e) => setEdit({ ...edit, first_name: e.target.value })} placeholder="First name" required />
                <input className="members-input" value={edit.last_name} onChange={(e) => setEdit({ ...edit, last_name: e.target.value })} placeholder="Last name" required />
                <input className="members-input" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} placeholder="Email" required />
                <input className="members-input" value={edit.mobile_phone} onChange={(e) => setEdit({ ...edit, mobile_phone: e.target.value })} placeholder="Phone" />
                <label className="members-checkbox">
                  <input
                    type="checkbox"
                    checked={edit.sms_opt_in}
                    onChange={(e) => {
                      setEdit({ ...edit, sms_opt_in: e.target.checked })
                      void handleSmsToggle(selected.member_id, e.target.checked)
                    }}
                  />
                  SMS opt-in
                </label>
                <p className="page__subtitle" style={{ margin: 0 }}>
                  SMS: {edit.sms_opt_in ? `Opted In${selected?.sms_opt_in_date ? ` (since ${new Date(selected.sms_opt_in_date).toLocaleDateString()})` : ''}` : 'Opted Out'}
                </p>
                <label className="members-checkbox"><input type="checkbox" checked={edit.email_opt_out} onChange={(e) => setEdit({ ...edit, email_opt_out: e.target.checked })} /> Email opt-out</label>
                <label className="members-checkbox"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> Active</label>
                <div className="modal__footer">
                  <button className="btn btn--outline btn--sm" type="button" onClick={closeEditor}>Cancel</button>
                  <button className="btn btn--primary btn--sm" type="submit" disabled={isSaving}>{isSaving ? 'Saving…' : 'Save changes'}</button>
                </div>
              </form>

              {isAdmin() && (
                <div style={{ marginTop: 16 }}>
                  <h3>SMS Consent Audit Log</h3>
                  <table className="members-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Action</th>
                        <th>Source</th>
                        <th>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {consentLog.length === 0 ? (
                        <tr>
                          <td colSpan={4}>No consent log entries.</td>
                        </tr>
                      ) : consentLog.map((row) => (
                        <tr key={row.consent_log_id}>
                          <td>{new Date(row.recorded_at).toLocaleString()}</td>
                          <td>{row.action === 'opt_in' ? 'Opt In' : 'Opt Out'}</td>
                          <td>{row.source}</td>
                          <td>{row.notes ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  )
}

export { MembersPage }