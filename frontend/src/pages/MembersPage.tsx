import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { adminApi } from '../api/admin'
import { membersApi } from '../api/members'
import type { MemberRecord } from '../api/members'
import type { IdentityStatus } from '../api/admin'
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
  const PAGE_SIZE = 100
  const { isAdmin } = useAuth()
  const isAdminUser = isAdmin()
  const modalRef = useRef<HTMLElement | null>(null)
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)
  const identityBulkInFlightRef = useRef(false)
  const identityBulkLastKeyRef = useRef('')
  const identityBulkLastRequestedAtRef = useRef(0)
  const identityBulkCooldownUntilRef = useRef(0)
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [members, setMembers] = useState<MemberRecord[]>([])
  const [totalMembers, setTotalMembers] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [inviteSuccess, setInviteSuccess] = useState<{ email: string; redeemUrl: string | null } | null>(null)
  const [selected, setSelected] = useState<MemberRecord | null>(null)
  const [edit, setEdit] = useState<MemberEditState | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isBulkInviting, setIsBulkInviting] = useState(false)
  const [identityByMemberId, setIdentityByMemberId] = useState<Record<string, IdentityStatus>>({})
  const [inviteInFlightByMemberId, setInviteInFlightByMemberId] = useState<Record<string, boolean>>({})
  const [hardDeleteTarget, setHardDeleteTarget] = useState<{ memberId: string; displayName: string } | null>(null)
  const [hardDeleteConfirmInput, setHardDeleteConfirmInput] = useState('')
  const [hardDeleteError, setHardDeleteError] = useState<string | null>(null)
  const [hardDeleteSuccess, setHardDeleteSuccess] = useState<string | null>(null)
  const [isHardDeleting, setIsHardDeleting] = useState(false)
  const [consentLog, setConsentLog] = useState<Array<{
    consent_log_id: string
    action: string
    source: string
    recorded_at: string
    notes: string | null
  }>>([])

  const totalLabel = useMemo(
    () => {
      if (totalMembers <= PAGE_SIZE) {
        return `${totalMembers} member${totalMembers === 1 ? '' : 's'}`
      }
      const start = (page - 1) * PAGE_SIZE + (members.length > 0 ? 1 : 0)
      const end = (page - 1) * PAGE_SIZE + members.length
      return `${start}-${end} of ${totalMembers} members`
    },
    [members.length, page, totalMembers],
  )

  const hasPreviousPage = page > 1
  const hasNextPage = page * PAGE_SIZE < totalMembers

  useEffect(() => {
    setPage(1)
  }, [search])

  const isEditorOpen = Boolean(edit)

  useEffect(() => {
    let active = true
    setIsLoading(true)
    setError(null)
    membersApi
      .list({ page, pageSize: PAGE_SIZE, search: search || undefined, isActive: true })
      .then((r) => {
        if (!active) return
        setMembers(r.data)
        setTotalMembers(r.total)
      })
      .catch((e: unknown) => { if (active) setError(toUserErrorMessage(e, 'Failed to load member records.')) })
      .finally(() => { if (active) setIsLoading(false) })
    return () => { active = false }
  }, [search, page])

  useEffect(() => {
    if (!isAdminUser || members.length === 0) {
      setIdentityByMemberId({})
      return
    }

    let cancelled = false
    const memberIds = members.map((member) => member.member_id)
    const memberIdsKey = memberIds.join(',')
    const now = Date.now()

    // Prevent storms: do not send duplicate requests for the same list in quick succession
    // and back off briefly after rate-limit responses.
    if (identityBulkInFlightRef.current) {
      return
    }
    if (now < identityBulkCooldownUntilRef.current) {
      return
    }
    if (
      identityBulkLastKeyRef.current === memberIdsKey
      && (now - identityBulkLastRequestedAtRef.current) < 15_000
    ) {
      return
    }

    identityBulkInFlightRef.current = true
    identityBulkLastKeyRef.current = memberIdsKey
    identityBulkLastRequestedAtRef.current = now

    adminApi.identityStatusBulk(memberIds)
      .then((result) => {
        if (cancelled) return
        const map: Record<string, IdentityStatus> = {}
        for (const row of result.data) {
          map[row.member_id] = row
        }
        setIdentityByMemberId(map)
      })
      .catch(() => {
        if (!cancelled) {
          // Hold previous data and cool down if backend is rate limiting.
          identityBulkCooldownUntilRef.current = Date.now() + 30_000
        }
      })
      .finally(() => {
        identityBulkInFlightRef.current = false
      })

    return () => {
      cancelled = true
      identityBulkInFlightRef.current = false
    }
  }, [members, isAdminUser])

  function startEdit(m: MemberRecord) {
    setSelected(m)
    setEdit(toEditState(m))
    if (isAdminUser) {
      membersApi.consentLog(m.member_id)
        .then(setConsentLog)
        .catch(() => setConsentLog([]))
    } else {
      setConsentLog([])
    }
  }

  function startCreate() {
    setSelected(null)
    setEdit({
      first_name: '',
      last_name: '',
      email: '',
      mobile_phone: '',
      channel_preference: 'email_only',
      sms_opt_in: false,
      email_opt_out: false,
      is_active: true,
    })
    setConsentLog([])
    setError(null)
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
    if (!edit) return
    setIsSaving(true)
    setError(null)
    try {
      const payload = {
        ...edit,
        ...applyChannelPreference(edit.channel_preference),
        mobile_phone: edit.mobile_phone || null,
      }

      if (selected) {
        const updated = await membersApi.update(selected.member_id, payload)
        setMembers((cur) => cur.map((m) => (m.member_id === updated.member_id ? updated : m)))
      } else {
        const created = await membersApi.create(payload)
        setMembers((cur) => [created, ...cur])
      }

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
        if (isAdminUser) {
          const logs = await membersApi.consentLog(memberId)
          setConsentLog(logs)
        }
      }
    } catch (err: unknown) {
      setError(toUserErrorMessage(err, 'SMS consent update failed.'))
    }
  }

  async function handleInvite(memberId: string) {
    setInviteInFlightByMemberId((current) => ({ ...current, [memberId]: true }))
    setError(null)
    setInviteSuccess(null)
    try {
      const invite = await adminApi.inviteIdentity(memberId)
      setInviteSuccess({
        email: invite.email,
        redeemUrl: invite.invite_redeem_url,
      })
      const status = await adminApi.identityStatus(memberId)
      setIdentityByMemberId((current) => ({ ...current, [memberId]: status }))
    } catch (err: unknown) {
      setError(toUserErrorMessage(err, 'Identity invite failed.'))
    } finally {
      setInviteInFlightByMemberId((current) => ({ ...current, [memberId]: false }))
    }
  }

  async function handleRelink(member: MemberRecord) {
    setError(null)
    try {
      const status = await adminApi.relinkIdentity({
        member_id: member.member_id,
        email: member.email,
      })
      setIdentityByMemberId((current) => ({ ...current, [member.member_id]: status }))
    } catch (err: unknown) {
      setError(toUserErrorMessage(err, 'Identity relink failed.'))
    }
  }

  async function handleInviteAllFiltered() {
    setIsBulkInviting(true)
    setError(null)
    setInviteSuccess(null)
    try {
      const memberIds = members.map((member) => member.member_id)
      await adminApi.inviteIdentityBulk(memberIds)
      const refreshed = await adminApi.identityStatusBulk(memberIds)
      const map: Record<string, IdentityStatus> = {}
      for (const row of refreshed.data) {
        map[row.member_id] = row
      }
      setIdentityByMemberId(map)
    } catch (err: unknown) {
      setError(toUserErrorMessage(err, 'Bulk identity invite failed.'))
    } finally {
      setIsBulkInviting(false)
    }
  }

  async function handleDeactivate(memberId: string, displayName: string) {
    if (!window.confirm(`Deactivate ${displayName}? They will be hidden from active lists but their data is preserved.`)) {
      return
    }
    setError(null)
    try {
      await membersApi.remove(memberId)
      setMembers((cur) => cur.filter((m) => m.member_id !== memberId))
    } catch (err: unknown) {
      setError(toUserErrorMessage(err, 'Deactivate failed.'))
    }
  }

  function requestHardDelete(memberId: string, displayName: string) {
    setHardDeleteError(null)
    setHardDeleteSuccess(null)
    setHardDeleteConfirmInput('')
    setHardDeleteTarget({ memberId, displayName })
  }

  function cancelHardDelete() {
    if (isHardDeleting) return
    setHardDeleteTarget(null)
    setHardDeleteConfirmInput('')
    setHardDeleteError(null)
  }

  async function confirmHardDelete() {
    if (!hardDeleteTarget) return
    const expected = hardDeleteTarget.displayName.trim()
    if (hardDeleteConfirmInput.trim() !== expected) {
      setHardDeleteError(`You must type "${expected}" exactly to confirm.`)
      return
    }
    setHardDeleteError(null)
    setIsHardDeleting(true)
    try {
      await membersApi.hardDelete(hardDeleteTarget.memberId)
      const removedName = hardDeleteTarget.displayName
      setMembers((cur) => cur.filter((m) => m.member_id !== hardDeleteTarget.memberId))
      setHardDeleteTarget(null)
      setHardDeleteConfirmInput('')
      setHardDeleteSuccess(`Permanently deleted ${removedName}.`)
    } catch (err: unknown) {
      const msg = toUserErrorMessage(err, 'Delete failed.')
      setHardDeleteError(msg)
      setError(msg)
    } finally {
      setIsHardDeleting(false)
    }
  }

  function describeIdentityStatus(memberId: string): string {
    const status = identityByMemberId[memberId]?.status
    if (!status) {
      return 'Pending'
    }
    return `${status.charAt(0).toUpperCase()}${status.slice(1)}`
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
        <button
          className="btn btn--outline btn--sm"
          type="button"
          disabled={!hasPreviousPage || isLoading}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          Prev
        </button>
        <button
          className="btn btn--outline btn--sm"
          type="button"
          disabled={!hasNextPage || isLoading}
          onClick={() => setPage((current) => current + 1)}
        >
          Next
        </button>
        {isAdminUser && (
          <button className="btn btn--primary btn--sm" type="button" onClick={startCreate}>
            Add member
          </button>
        )}
        {isAdminUser && (
          <button className="btn btn--outline btn--sm" type="button" disabled={isBulkInviting} onClick={handleInviteAllFiltered}>
            {isBulkInviting ? 'Inviting…' : 'Invite all filtered'}
          </button>
        )}
      </section>

      {error && <p className="ui-notice ui-notice--error">{error}</p>}
      {hardDeleteSuccess && (
        <p className="ui-notice ui-notice--success" role="status">{hardDeleteSuccess}</p>
      )}
      {inviteSuccess && (
        <p className="ui-notice ui-notice--success">
          Invite recorded for {inviteSuccess.email}.
          {' '}
          {inviteSuccess.redeemUrl
            ? <a href={inviteSuccess.redeemUrl} target="_blank" rel="noreferrer">Open redeem link</a>
            : 'No redeem URL was returned. Check Entra invitation settings and delivery logs.'}
        </p>
      )}

      <section className="card members-table-wrap">
        {isLoading ? (
          <div style={{ padding: '1rem' }}>
            <LoadingSkeleton lines={5} />
          </div>
        ) : (
          <table className="members-table">
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>Phone</th><th>Channels</th><th>Status</th><th>Identity</th><th>Actions</th>
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
                  <td>{describeIdentityStatus(m.member_id)}</td>
                  <td>
                    <div className="members-row-actions">
                      <button className="btn btn--primary btn--sm" onClick={() => startEdit(m)}>Edit</button>
                      {isAdminUser && (
                        <button
                          className="btn btn--outline btn--sm"
                          type="button"
                          disabled={Boolean(inviteInFlightByMemberId[m.member_id])}
                          onClick={() => handleInvite(m.member_id)}
                        >
                          {inviteInFlightByMemberId[m.member_id] ? 'Inviting…' : 'Invite'}
                        </button>
                      )}
                      {isAdminUser && (
                        <button className="btn btn--outline btn--sm" type="button" onClick={() => handleRelink(m)}>
                          Relink
                        </button>
                      )}
                      {isAdminUser && (
                        <button
                          className="btn btn--outline btn--sm"
                          type="button"
                          onClick={() => void handleDeactivate(m.member_id, `${m.first_name} ${m.last_name}`)}
                        >
                          Deactivate
                        </button>
                      )}
                      {isAdminUser && (
                        <button
                          className="btn btn--sm"
                          type="button"
                          style={{ background: '#b91c1c', borderColor: '#b91c1c', color: '#fff' }}
                          onClick={() => requestHardDelete(m.member_id, `${m.first_name} ${m.last_name}`)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {hardDeleteTarget && (
        <div className="modal-overlay" role="presentation" onClick={cancelHardDelete}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="hard-delete-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal__header">
              <h2 id="hard-delete-title" className="modal__title" style={{ color: '#b91c1c' }}>
                Permanently delete member?
              </h2>
              <button className="btn btn--outline btn--sm" type="button" onClick={cancelHardDelete} disabled={isHardDeleting}>
                Cancel
              </button>
            </div>
            <div className="modal__body">
              <p>
                This permanently removes <strong>{hardDeleteTarget.displayName}</strong> and cannot be undone.
                If you only want to hide them from active lists, use <em>Deactivate</em> instead.
              </p>
              <label className="members-search-label" htmlFor="hard-delete-confirm">
                Type <code>{hardDeleteTarget.displayName}</code> to confirm
              </label>
              <input
                id="hard-delete-confirm"
                className="members-input"
                autoFocus
                value={hardDeleteConfirmInput}
                onChange={(e) => {
                  setHardDeleteConfirmInput(e.target.value)
                  if (hardDeleteError) setHardDeleteError(null)
                }}
                disabled={isHardDeleting}
                placeholder={hardDeleteTarget.displayName}
              />
              {hardDeleteError && (
                <p className="ui-notice ui-notice--error" role="alert" style={{ marginTop: '0.5rem' }}>
                  {hardDeleteError}
                </p>
              )}
              <div className="members-row-actions" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
                <button
                  className="btn btn--outline btn--sm"
                  type="button"
                  onClick={cancelHardDelete}
                  disabled={isHardDeleting}
                >
                  Cancel
                </button>
                <button
                  className="btn btn--sm"
                  type="button"
                  style={{ background: '#b91c1c', borderColor: '#b91c1c', color: '#fff' }}
                  onClick={() => void confirmHardDelete()}
                  disabled={
                    isHardDeleting ||
                    hardDeleteConfirmInput.trim() !== hardDeleteTarget.displayName.trim()
                  }
                >
                  {isHardDeleting ? 'Deleting…' : 'Permanently delete'}
                </button>
              </div>
            </div>
          </section>
        </div>
      )}

      {edit && (
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
              <h2 className="modal__title">{selected ? 'Edit member' : 'Add member'}</h2>
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

                    if (didSmsChange && selected) {
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

              {isAdminUser && selected && (
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