import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { membersApi } from '../api/members'
import type { MemberRecord } from '../api/members'
import LoadingSkeleton from '../components/LoadingSkeleton'
import { useAuth } from '../hooks/useAuth'
import { toUserErrorMessage } from '../utils/errorMessage'

interface MemberEditState {
  first_name: string
  last_name: string
  email: string
  mobile_phone: string
  channel_preference: 'email_only' | 'sms_only' | 'both'
  sms_opt_in: boolean
  email_opt_out: boolean
  is_active: boolean
}

function deriveChannelPreference(smsOptIn: boolean, emailOptOut: boolean): 'email_only' | 'sms_only' | 'both' {
  if (smsOptIn && !emailOptOut) {
    return 'both'
  }
  if (smsOptIn && emailOptOut) {
    return 'sms_only'
  }
  return 'email_only'
}

function applyChannelPreference(preference: 'email_only' | 'sms_only' | 'both'): { sms_opt_in: boolean; email_opt_out: boolean } {
  if (preference === 'both') {
    return { sms_opt_in: true, email_opt_out: false }
  }
  if (preference === 'sms_only') {
    return { sms_opt_in: true, email_opt_out: true }
  }
  return { sms_opt_in: false, email_opt_out: false }
}

function toEditState(m: MemberRecord): MemberEditState {
  const channelPreference = deriveChannelPreference(m.sms_opt_in, m.email_opt_out)
  return {
    first_name: m.first_name,
    last_name: m.last_name,
    email: m.email,
    mobile_phone: m.mobile_phone ?? '',
    channel_preference: channelPreference,
    sms_opt_in: m.sms_opt_in,
    email_opt_out: m.email_opt_out,
    is_active: m.is_active,
  }
}

function MembersPage() {
  const { isAdmin } = useAuth()
  const modalRef = useRef<HTMLElement | null>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
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

  const isEditorOpen = Boolean(selected && edit)

  useEffect(() => {
    let active = true
    setIsLoading(true)
    setError(null)
    membersApi
      .list({ page: 1, pageSize: 100, search: search || undefined, isActive: true })
      .then((r) => { if (active) setMembers(r.data) })
      .catch((e: unknown) => { if (active) setError(toUserErrorMessage(e, 'Failed to load member records.')) })
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

  const closeEditor = useCallback(() => {
    setSelected(null)
    setEdit(null)
    setError(null)
  }, [])

  useEffect(() => {
    if (!isEditorOpen) return

    const modalEl = modalRef.current
    if (!modalEl) return

    const focusableSelector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    const getFocusableElements = () =>
      Array.from(modalEl.querySelectorAll<HTMLElement>(focusableSelector)).filter(
        (element) => !element.hasAttribute('disabled') && element.getAttribute('aria-hidden') !== 'true'
      )

    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const originalBodyOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    const focusableElements = getFocusableElements()
    if (focusableElements.length > 0) {
      focusableElements[0].focus()
    } else {
      modalEl.focus()
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeEditor()
        return
      }

      if (event.key !== 'Tab') return

      const nodes = getFocusableElements()
      if (nodes.length === 0) {
        event.preventDefault()
        modalEl.focus()
        return
      }

      const first = nodes[0]
      const last = nodes[nodes.length - 1]
      const activeElement = document.activeElement as HTMLElement | null

      if (event.shiftKey) {
        if (activeElement === first || !modalEl.contains(activeElement)) {
          event.preventDefault()
          last.focus()
        }
        return
      }

      if (activeElement === last || !modalEl.contains(activeElement)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = originalBodyOverflow
      previouslyFocusedRef.current?.focus()
    }
  }, [closeEditor, isEditorOpen])

  async function handleSave(e: FormEvent) {
    e.preventDefault()
    if (!selected || !edit) return
    setIsSaving(true)
    setError(null)
    try {
      const updated = await membersApi.update(selected.member_id, {
        ...edit,
        ...applyChannelPreference(edit.channel_preference),
        mobile_phone: edit.mobile_phone || null,
      })
      setMembers((cur) => cur.map((m) => (m.member_id === updated.member_id ? updated : m)))
      closeEditor()
    } catch (err: unknown) {
      setError(toUserErrorMessage(err, 'Save failed.'))
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
      setError(toUserErrorMessage(err, 'SMS consent update failed.'))
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

      {error && <p className="ui-notice ui-notice--error">{error}</p>}

      <section className="card members-table-wrap">
        {isLoading ? (
          <div style={{ padding: '1rem' }}>
            <LoadingSkeleton lines={5} />
          </div>
        ) : (
          <table className="members-table">
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>Phone</th><th>Channels</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.member_id}>
                  <td>{m.first_name} {m.last_name}</td>
                  <td>{m.email}</td>
                  <td>{m.mobile_phone ?? '-'}</td>
                  <td>{deriveChannelPreference(m.sms_opt_in, m.email_opt_out).replace('_', ' ')}</td>
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
          <section
            ref={modalRef}
            className="modal"
            role="dialog"
            tabIndex={-1}
            aria-modal="true"
            aria-label="Edit member"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__header">
              <h2 className="modal__title">Edit member</h2>
              <button className="btn btn--outline btn--sm" type="button" onClick={closeEditor}>Close</button>
            </div>
            <div className="modal__body">
              <form className="members-form" onSubmit={handleSave}>
                <label className="members-search-label" htmlFor="member-first-name">First name</label>
                <input id="member-first-name" className="members-input" value={edit.first_name} onChange={(e) => setEdit({ ...edit, first_name: e.target.value })} placeholder="First name" required />
                <label className="members-search-label" htmlFor="member-last-name">Last name</label>
                <input id="member-last-name" className="members-input" value={edit.last_name} onChange={(e) => setEdit({ ...edit, last_name: e.target.value })} placeholder="Last name" required />
                <label className="members-search-label" htmlFor="member-email">Email</label>
                <input id="member-email" className="members-input" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} placeholder="Email" required />
                <label className="members-search-label" htmlFor="member-phone">Phone</label>
                <input id="member-phone" className="members-input" value={edit.mobile_phone} onChange={(e) => setEdit({ ...edit, mobile_phone: e.target.value })} placeholder="Phone" />
                <label className="members-search-label" htmlFor="member-channel-preference">Notification channels</label>
                <select
                  id="member-channel-preference"
                  className="members-input"
                  value={edit.channel_preference}
                  onChange={(e) => {
                    const nextPreference = e.target.value as 'email_only' | 'sms_only' | 'both'
                    const nextFlags = applyChannelPreference(nextPreference)
                    const didSmsChange = nextFlags.sms_opt_in !== edit.sms_opt_in

                    setEdit({
                      ...edit,
                      channel_preference: nextPreference,
                      sms_opt_in: nextFlags.sms_opt_in,
                      email_opt_out: nextFlags.email_opt_out,
                    })

                    if (didSmsChange) {
                      void handleSmsToggle(selected.member_id, nextFlags.sms_opt_in)
                    }
                  }}
                >
                  <option value="email_only">Email only</option>
                  <option value="sms_only">SMS only</option>
                  <option value="both">Both email and SMS</option>
                </select>
                <p className="page__subtitle" style={{ margin: 0 }}>
                  SMS: {edit.sms_opt_in ? `Opted In${selected?.sms_opt_in_date ? ` (since ${new Date(selected.sms_opt_in_date).toLocaleDateString()})` : ''}` : 'Opted Out'}
                </p>
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