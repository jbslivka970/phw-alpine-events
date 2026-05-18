import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { assignmentsApi, eventsApi, rsvpApi } from '../api/events'
import { membersApi } from '../api/members'
import type { AssignmentRecommendationRow, EventRecord } from '../api/events'

type Assignment = {
  assignment_id: string
  member_id: string
  first_name: string
  last_name: string
  role: string
  assigned_at: string
  attended: boolean
  attendance_notes?: string | null
}

type MemberSearchRow = {
  member_id: string
  first_name: string
  last_name: string
  email: string
}

type RsvpPoolRow = {
  member_id: string
  first_name?: string
  last_name?: string
  response: string
  response_role?: 'MENTOR' | 'PARTICIPANT' | null
}

type ParticipationSummary = {
  events_attended: number
  events_attended_prior_year: number
  mentor_attended: number
  mentor_attended_prior_year: number
  participant_attended: number
  participant_attended_prior_year: number
}

type EventCapacitySnapshot = {
  mentor_capacity: number | null
  participant_capacity: number | null
  capacity: number | null
}

const EMPTY_PARTICIPATION: ParticipationSummary = {
  events_attended: 0,
  events_attended_prior_year: 0,
  mentor_attended: 0,
  mentor_attended_prior_year: 0,
  participant_attended: 0,
  participant_attended_prior_year: 0,
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) {
    return 'Not set'
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    return value
  }

  return parsed.toLocaleString('en-GB', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function parseDispositionFilename(headerValue: string | null): string | null {
  if (!headerValue) {
    return null
  }

  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(headerValue)
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1])
  }

  const plainMatch = /filename="?([^";]+)"?/i.exec(headerValue)
  return plainMatch?.[1] ?? null
}

function downloadBlobFile(blob: Blob, headers: Headers, fallbackFilename: string): void {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  const fromHeader = parseDispositionFilename(headers.get('content-disposition'))
  anchor.href = objectUrl
  anchor.download = fromHeader ?? fallbackFilename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)
}

function EventAssignmentPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const eventId = id ?? ''

  const [eventDetail, setEventDetail] = useState<EventRecord | null>(null)
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [rsvps, setRsvps] = useState<RsvpPoolRow[]>([])
  const [participation, setParticipation] = useState<Record<string, ParticipationSummary>>({})
  const [priorityRole, setPriorityRole] = useState<'MENTOR' | 'PARTICIPANT'>('PARTICIPANT')
  const [recommendations, setRecommendations] = useState<AssignmentRecommendationRow[]>([])
  const [recommendationsLoading, setRecommendationsLoading] = useState(false)
  const [manualSearch, setManualSearch] = useState('')
  const [manualResults, setManualResults] = useState<MemberSearchRow[]>([])
  const [manualLoading, setManualLoading] = useState(false)
  const [closingAtCapacity, setClosingAtCapacity] = useState(false)
  const [reportActionBusy, setReportActionBusy] = useState<'csv' | 'pdf' | 'record' | 'lead' | 'participation' | null>(null)
  const [eventCapacity, setEventCapacity] = useState<EventCapacitySnapshot | null>(null)
  const [closeAtCapacityNotice, setCloseAtCapacityNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const assignedMemberIds = useMemo(() => new Set(assignments.map((a) => a.member_id)), [assignments])

  async function refreshEventData(targetEventId: string): Promise<void> {
    const [asns, eventRsvps, eventDetail] = await Promise.all([
      assignmentsApi.list(targetEventId),
      rsvpApi.list(targetEventId),
      eventsApi.get(targetEventId),
    ])

    setEventDetail(eventDetail)
    setAssignments(asns as Assignment[])
    setEventCapacity(eventDetail ? {
      mentor_capacity: eventDetail.mentor_capacity,
      participant_capacity: eventDetail.participant_capacity,
      capacity: eventDetail.capacity,
    } : {
      mentor_capacity: null,
      participant_capacity: null,
      capacity: null,
    })
    const relevantRsvps = eventRsvps.filter((row) => ['yes', 'maybe', 'waitlist'].includes(row.response))
    setRsvps(relevantRsvps)

    const uniqueMemberIds = Array.from(new Set([
      ...asns.map((row) => row.member_id),
      ...relevantRsvps.map((row) => row.member_id),
    ]))

    const participationRows = await Promise.all(uniqueMemberIds.map(async (memberId) => {
      try {
        const row = await membersApi.participation(memberId)
        return [memberId, {
          events_attended: row.events_attended,
          events_attended_prior_year: row.events_attended_prior_year,
          mentor_attended: row.mentor_attended,
          mentor_attended_prior_year: row.mentor_attended_prior_year,
          participant_attended: row.participant_attended,
          participant_attended_prior_year: row.participant_attended_prior_year,
        }] as const
      } catch {
        return [memberId, EMPTY_PARTICIPATION] as const
      }
    }))

    setParticipation(Object.fromEntries(participationRows))
  }

  useEffect(() => {
    if (!eventId) {
      return
    }

    let active = true
    refreshEventData(eventId)
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Failed to load assignments')
        }
      })

    return () => {
      active = false
    }
  }, [eventId])

  useEffect(() => {
    if (!eventId) {
      return
    }

    let active = true
    setRecommendationsLoading(true)
    assignmentsApi.recommendations(eventId, priorityRole)
      .then((result) => {
        if (!active) {
          return
        }
        setRecommendations(result.rows)
      })
      .catch(() => {
        if (!active) {
          return
        }
        setRecommendations([])
      })
      .finally(() => {
        if (active) {
          setRecommendationsLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [eventId, priorityRole])

  useEffect(() => {
    if (!eventId) {
      return
    }

    const term = manualSearch.trim()
    if (term.length < 2) {
      setManualResults([])
      setManualLoading(false)
      return
    }

    let active = true
    setManualLoading(true)
    membersApi.list({ page: 1, pageSize: 20, search: term, isActive: true })
      .then((result) => {
        if (!active) {
          return
        }
        setManualResults(result.data.map((row) => ({
          member_id: row.member_id,
          first_name: row.first_name,
          last_name: row.last_name,
          email: row.email,
        })))
      })
      .catch(() => {
        if (active) {
          setManualResults([])
        }
      })
      .finally(() => {
        if (active) {
          setManualLoading(false)
        }
      })

    return () => {
      active = false
    }
  }, [eventId, manualSearch])

  async function assignMember(memberId: string, role: 'MENTOR' | 'PARTICIPANT') {
    if (!eventId) {
      return
    }
    try {
      await assignmentsApi.create(eventId, { member_id: memberId, role })
      await refreshEventData(eventId)
      setCloseAtCapacityNotice(null)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to assign member')
    }
  }

  async function closeEventAtCapacity() {
    if (!eventId) {
      return
    }

    setClosingAtCapacity(true)
    setError(null)
    setCloseAtCapacityNotice(null)
    try {
      const result = await assignmentsApi.closeAtCapacity(eventId)
      if (result.event) {
        setEventCapacity({
          mentor_capacity: result.event.mentor_capacity,
          participant_capacity: result.event.participant_capacity,
          capacity: result.event.capacity,
        })
      }
      setCloseAtCapacityNotice(
        `${result.message} Volunteer cap: ${result.event?.mentor_capacity ?? 0}. Participant cap: ${result.event?.participant_capacity ?? 0}.`
      )
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to close event at capacity')
    } finally {
      setClosingAtCapacity(false)
    }
  }

  async function updateAttendance(assignmentId: string, attended: boolean) {
    if (!eventId) {
      return
    }
    try {
      await assignmentsApi.setAttendance(eventId, assignmentId, { attended })
      await refreshEventData(eventId)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update attendance')
    }
  }

  async function deleteAssignment(assignmentId: string) {
    if (!eventId) {
      return
    }
    if (!window.confirm('Are you sure you want to remove this person from assignments?')) {
      return
    }

    try {
      await assignmentsApi.remove(eventId, assignmentId)
      await refreshEventData(eventId)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to remove assignment')
    }
  }

  async function setRsvpNoAndRemove(assignment: Assignment) {
    if (!eventId) {
      return
    }
    if (!window.confirm('Set RSVP to No and remove this person from assignments?')) {
      return
    }

    try {
      await rsvpApi.upsert(eventId, {
        member_id: assignment.member_id,
        response: 'no',
      })
      await assignmentsApi.remove(eventId, assignment.assignment_id)
      await refreshEventData(eventId)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to set RSVP to No and remove assignment')
    }
  }

  function participationFor(memberId: string): ParticipationSummary {
    return participation[memberId] ?? EMPTY_PARTICIPATION
  }

  function roleLabel(role: 'MENTOR' | 'PARTICIPANT' | null | undefined): string {
    if (role === 'MENTOR') {
      return 'Volunteer'
    }
    if (role === 'PARTICIPANT') {
      return 'Participant'
    }
    return 'Unspecified'
  }

  const rankedRsvps = useMemo(() => {
    const rows = [...rsvps]
    const recommendationRank = new Map(recommendations.map((row) => [row.member_id, row.rank]))
    rows.sort((a, b) => {
      const aRank = recommendationRank.get(a.member_id)
      const bRank = recommendationRank.get(b.member_id)
      if (aRank !== undefined && bRank !== undefined && aRank !== bRank) {
        return aRank - bRank
      }

      const aPart = participationFor(a.member_id)
      const bPart = participationFor(b.member_id)

      const aCurrent = priorityRole === 'MENTOR' ? aPart.mentor_attended : aPart.participant_attended
      const bCurrent = priorityRole === 'MENTOR' ? bPart.mentor_attended : bPart.participant_attended
      if (aCurrent !== bCurrent) {
        return aCurrent - bCurrent
      }

      const aPrior = priorityRole === 'MENTOR' ? aPart.mentor_attended_prior_year : aPart.participant_attended_prior_year
      const bPrior = priorityRole === 'MENTOR' ? bPart.mentor_attended_prior_year : bPart.participant_attended_prior_year
      if (aPrior !== bPrior) {
        return aPrior - bPrior
      }

      const aName = `${a.first_name ?? ''} ${a.last_name ?? ''}`.trim()
      const bName = `${b.first_name ?? ''} ${b.last_name ?? ''}`.trim()
      return aName.localeCompare(bName)
    })

    return rows
  }, [rsvps, participation, priorityRole, recommendations])

  const recommendationByMember = useMemo(
    () => new Map(recommendations.map((row) => [row.member_id, row])),
    [recommendations]
  )

  const assignedVolunteerCount = useMemo(
    () => assignments.filter((assignment) => assignment.role === 'MENTOR').length,
    [assignments]
  )

  const assignedParticipantCount = useMemo(
    () => assignments.filter((assignment) => assignment.role !== 'MENTOR').length,
    [assignments]
  )

  const assignedTotalCount = assignments.length
  const volunteerCapacity = eventCapacity?.mentor_capacity ?? null
  const participantCapacity = eventCapacity?.participant_capacity ?? null
  const totalCapacity = eventCapacity?.capacity ?? null
  const yesCount = useMemo(() => rsvps.filter((row) => row.response === 'yes').length, [rsvps])
  const maybeCount = useMemo(() => rsvps.filter((row) => row.response === 'maybe').length, [rsvps])
  const waitlistCount = useMemo(() => rsvps.filter((row) => row.response === 'waitlist').length, [rsvps])

  async function runReportAction<T extends 'csv' | 'pdf' | 'record' | 'lead' | 'participation'>(
    action: T,
    runner: () => Promise<void>
  ): Promise<void> {
    setReportActionBusy(action)
    setError(null)
    try {
      await runner()
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to complete event summary action')
    } finally {
      setReportActionBusy(null)
    }
  }

  async function downloadReportCsv(): Promise<void> {
    await runReportAction('csv', async () => {
      const { blob, headers } = await eventsApi.downloadReportCsv(eventId)
      downloadBlobFile(blob, headers, `event-report-${eventId}.csv`)
    })
  }

  async function downloadReportPdf(): Promise<void> {
    await runReportAction('pdf', async () => {
      const { blob, headers } = await eventsApi.downloadReportPdf(eventId)
      downloadBlobFile(blob, headers, `event-report-${eventId}.pdf`)
    })
  }

  async function downloadReportText(): Promise<void> {
    await runReportAction('record', async () => {
      const { blob, headers } = await eventsApi.downloadReportText(eventId)
      downloadBlobFile(blob, headers, `event-report-${eventId}.txt`)
    })
  }

  async function sendLeadPrepSummary(): Promise<void> {
    await runReportAction('lead', async () => {
      await eventsApi.sendLeadPrepSummary(eventId)
    })
  }

  async function sendParticipationSummary(): Promise<void> {
    await runReportAction('participation', async () => {
      await eventsApi.sendParticipationSummary(eventId)
    })
  }

  function quotaText(assigned: number, quota: number | null): string {
    if (quota === null) {
      return `${assigned} / unlimited`
    }
    return `${assigned} / ${quota}`
  }

  function quotaMeta(assigned: number, quota: number | null): string {
    if (quota === null) {
      return 'No quota set'
    }
    const remaining = quota - assigned
    if (remaining > 0) {
      return `${remaining} open`
    }
    if (remaining === 0) {
      return 'At capacity'
    }
    return `${Math.abs(remaining)} over capacity`
  }

  const assignmentRolesByMember = useMemo(() => {
    const roleMap = new Map<string, Array<'MENTOR' | 'PARTICIPANT'>>()
    assignments.forEach((assignment) => {
      const role = assignment.role === 'MENTOR' ? 'MENTOR' : 'PARTICIPANT'
      const existingRoles = roleMap.get(assignment.member_id) ?? []
      if (!existingRoles.includes(role)) {
        existingRoles.push(role)
      }
      roleMap.set(assignment.member_id, existingRoles)
    })
    return roleMap
  }, [assignments])

  return (
    <div className="page event-assignments-page">
      <div className="event-assignments-header">
        <div>
          <h1 className="page__title">{eventDetail?.title ?? 'Event Details'}</h1>
          <p className="page__subtitle">Review event details, RSVP activity, assignments, pre-event lead prep, and post-event participation summary actions in one place.</p>
        </div>
        <button className="btn btn--outline btn--sm" onClick={() => navigate('/events')}>Back to Events</button>
      </div>
      {error && <p className="members-error">{error}</p>}

      <section className="card members-table-wrap" style={{ display: 'grid', gap: 18 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <div style={{ flex: '1 1 420px' }}>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              <span className={`status-pill status-pill--${eventDetail?.status ?? 'draft'}`}>{eventDetail?.status ?? 'draft'}</span>
              <span className="assignment-role-chip assignment-role-chip--participant">{formatDateTime(eventDetail?.event_date)}</span>
              <span className="assignment-role-chip assignment-role-chip--unknown">{eventDetail?.location ?? 'Location TBD'}</span>
            </div>
            {eventDetail?.description && (
              <p style={{ margin: '0 0 12px', lineHeight: 1.6 }}>{eventDetail.description}</p>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              <div>
                <p style={{ margin: '0 0 4px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.7 }}>Event Lead</p>
                <p style={{ margin: 0, fontWeight: 600 }}>{eventDetail?.event_lead_name ?? 'Not set'}</p>
                <p style={{ margin: '4px 0 0' }}>{eventDetail?.event_lead_email ?? 'No lead email set'}</p>
              </div>
              <div>
                <p style={{ margin: '0 0 4px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.7 }}>Scheduler Summary Recipient</p>
                <p style={{ margin: 0, fontWeight: 600 }}>{eventDetail?.scheduler_email ?? 'Using event creator fallback'}</p>
                <p style={{ margin: '4px 0 0' }}>{eventDetail?.scheduler_email ? 'Post-event participation summary will send here.' : 'If blank, the post-event summary falls back to the event creator email.'}</p>
              </div>
              <div>
                <p style={{ margin: '0 0 4px', fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.7 }}>Schedule</p>
                <p style={{ margin: 0 }}>Start: {formatDateTime(eventDetail?.event_date)}</p>
                <p style={{ margin: '4px 0 0' }}>End: {formatDateTime(eventDetail?.end_date)}</p>
              </div>
            </div>
          </div>

          <div style={{ flex: '0 1 380px', display: 'grid', gap: 10, minWidth: 280 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 10 }}>
              <div className="assignment-capacity-card">
                <p className="assignment-capacity-label">RSVP Yes</p>
                <p className="assignment-capacity-value">{yesCount}</p>
                <p className="assignment-capacity-meta">Ready to assign</p>
              </div>
              <div className="assignment-capacity-card">
                <p className="assignment-capacity-label">Maybe / Waitlist</p>
                <p className="assignment-capacity-value">{maybeCount + waitlistCount}</p>
                <p className="assignment-capacity-meta">{maybeCount} maybe, {waitlistCount} waitlist</p>
              </div>
              <div className="assignment-capacity-card">
                <p className="assignment-capacity-label">Assigned</p>
                <p className="assignment-capacity-value">{assignedTotalCount}</p>
                <p className="assignment-capacity-meta">{assignedVolunteerCount} volunteer, {assignedParticipantCount} participant</p>
              </div>
              <div className="assignment-capacity-card">
                <p className="assignment-capacity-label">Lead Prep</p>
                <p className="assignment-capacity-value">{eventDetail?.event_lead_email ? 'Ready' : 'Blocked'}</p>
                <p className="assignment-capacity-meta">{eventDetail?.event_lead_email ? 'Lead email present' : 'Add lead email first'}</p>
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button
                className="btn btn--sm"
                onClick={() => void sendLeadPrepSummary()}
                disabled={eventDetail?.status === 'completed' || eventDetail?.status === 'cancelled' || !eventDetail?.event_lead_email || reportActionBusy !== null}
                title={eventDetail?.status === 'completed' ? 'Use the participation summary after the event is completed.' : eventDetail?.status === 'cancelled' ? 'Lead prep is not available for cancelled events.' : !eventDetail?.event_lead_email ? 'Add an event lead email before sending the lead prep summary.' : undefined}
              >
                {reportActionBusy === 'lead' ? 'Sending…' : 'Send Lead Prep Summary'}
              </button>
              <button
                className="btn btn--sm btn--outline"
                onClick={() => void sendParticipationSummary()}
                disabled={eventDetail?.status !== 'completed' || reportActionBusy !== null}
                title={eventDetail?.status !== 'completed' ? 'Complete the event before sending the participation summary.' : undefined}
              >
                {reportActionBusy === 'participation' ? 'Sending…' : 'Send Participation Summary'}
              </button>
              <button className="btn btn--outline btn--sm" disabled={eventDetail?.status !== 'completed' || reportActionBusy !== null} onClick={() => void downloadReportCsv()}>
                {reportActionBusy === 'csv' ? 'Preparing…' : 'CSV'}
              </button>
              <button className="btn btn--outline btn--sm" disabled={eventDetail?.status !== 'completed' || reportActionBusy !== null} onClick={() => void downloadReportPdf()}>
                {reportActionBusy === 'pdf' ? 'Preparing…' : 'PDF'}
              </button>
              <button className="btn btn--outline btn--sm" disabled={eventDetail?.status !== 'completed' || reportActionBusy !== null} onClick={() => void downloadReportText()}>
                {reportActionBusy === 'record' ? 'Preparing…' : 'Roster Record'}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="card members-table-wrap">
        <h2>Capacity Controls</h2>
        <p className="page__subtitle event-assignments-note">
          Lock this event at its current assigned/confirmed seats. Future "Yes" RSVP submissions will be stored as waitlist when full.
        </p>
        <div className="assignment-capacity-grid" aria-label="Assignment capacity summary">
          <div className={`assignment-capacity-card ${volunteerCapacity !== null && assignedVolunteerCount >= volunteerCapacity ? 'assignment-capacity-card--full' : ''}`}>
            <p className="assignment-capacity-label">Volunteers</p>
            <p className="assignment-capacity-value">{quotaText(assignedVolunteerCount, volunteerCapacity)}</p>
            <p className="assignment-capacity-meta">{quotaMeta(assignedVolunteerCount, volunteerCapacity)}</p>
          </div>
          <div className={`assignment-capacity-card ${participantCapacity !== null && assignedParticipantCount >= participantCapacity ? 'assignment-capacity-card--full' : ''}`}>
            <p className="assignment-capacity-label">Participants</p>
            <p className="assignment-capacity-value">{quotaText(assignedParticipantCount, participantCapacity)}</p>
            <p className="assignment-capacity-meta">{quotaMeta(assignedParticipantCount, participantCapacity)}</p>
          </div>
          <div className={`assignment-capacity-card ${totalCapacity !== null && assignedTotalCount >= totalCapacity ? 'assignment-capacity-card--full' : ''}`}>
            <p className="assignment-capacity-label">Total Seats</p>
            <p className="assignment-capacity-value">{quotaText(assignedTotalCount, totalCapacity)}</p>
            <p className="assignment-capacity-meta">{quotaMeta(assignedTotalCount, totalCapacity)}</p>
          </div>
        </div>
        <button className="btn btn--sm" disabled={closingAtCapacity} onClick={() => void closeEventAtCapacity()}>
          {closingAtCapacity ? 'Closing…' : 'Close Event At Capacity'}
        </button>
        {closeAtCapacityNotice && <p className="members-loading event-assignments-notice">{closeAtCapacityNotice}</p>}
      </section>

      <section className="card members-table-wrap">
        <h2>Manual Association</h2>
        <p className="page__subtitle event-assignments-note">
          Search active members and assign directly, even if they did not RSVP yet.
        </p>
        <input
          className="members-search"
          value={manualSearch}
          onChange={(e) => setManualSearch(e.target.value)}
          placeholder="Search member name or email"
        />
        {manualLoading && <p className="members-loading">Searching members…</p>}
        {!manualLoading && manualSearch.trim().length >= 2 && manualResults.length === 0 && (
          <p className="members-loading">No active members found.</p>
        )}
        {!manualLoading && manualResults.length > 0 && (
          <table className="members-table event-assignments-table event-assignments-table--manual">
            <thead>
              <tr><th>Name</th><th>Email</th><th>Assign</th></tr>
            </thead>
            <tbody>
              {manualResults.map((member) => {
                const alreadyAssigned = assignedMemberIds.has(member.member_id)
                const assignedRoles = assignmentRolesByMember.get(member.member_id) ?? []
                const name = `${member.first_name ?? ''} ${member.last_name ?? ''}`.trim()
                return (
                  <tr key={member.member_id}>
                    <td>{name || member.member_id}</td>
                    <td>{member.email}</td>
                    <td>
                      {alreadyAssigned ? (
                        <div className="assignment-status">
                          {assignedRoles.map((role) => (
                            <span
                              key={`${member.member_id}-${role}`}
                              className={`assignment-role-chip ${role === 'MENTOR' ? 'assignment-role-chip--mentor' : 'assignment-role-chip--participant'}`}
                            >
                              Assigned {roleLabel(role)}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <div className="members-row-actions">
                          <button className="btn btn--sm" onClick={() => assignMember(member.member_id, 'PARTICIPANT')}>Assign Participant</button>
                          <button className="btn btn--sm btn--outline" onClick={() => assignMember(member.member_id, 'MENTOR')}>Assign Volunteer</button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card members-table-wrap">
        <h2>RSVP Pool</h2>
        <p className="page__subtitle event-assignments-note">
          Priority sorted by lowest {priorityRole === 'MENTOR' ? 'volunteer shifts' : 'participant attendance'} first.
        </p>
        <div className="assignment-priority-controls">
          <button className={`btn btn--sm ${priorityRole === 'PARTICIPANT' ? '' : 'btn--outline'}`} onClick={() => setPriorityRole('PARTICIPANT')}>
            Prioritize Participant Role
          </button>
          <button className={`btn btn--sm ${priorityRole === 'MENTOR' ? '' : 'btn--outline'}`} onClick={() => setPriorityRole('MENTOR')}>
            Prioritize Volunteer Role
          </button>
        </div>
        {recommendationsLoading && <p className="members-loading">Refreshing equity recommendations…</p>}
        <table className="members-table">
          <thead>
            <tr><th>Name</th><th>Response</th><th>RSVP Role</th><th>Volunteer Y/PY</th><th>Participant Y/PY</th><th>Equity</th><th>Assign</th></tr>
          </thead>
          <tbody>
            {rankedRsvps.length === 0 ? (
              <tr><td colSpan={7}>No RSVP rows to assign.</td></tr>
            ) : rankedRsvps.map((row) => {
              const name = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim()
              const alreadyAssigned = assignedMemberIds.has(row.member_id)
              const assignedRoles = assignmentRolesByMember.get(row.member_id) ?? []
              const p = participationFor(row.member_id)
              const recommendation = recommendationByMember.get(row.member_id)
              return (
                <tr key={`${row.member_id}-${row.response}`}>
                  <td>{name || row.member_id}</td>
                  <td>{row.response}</td>
                  <td>
                    <span
                      className={`assignment-role-chip ${
                        row.response_role === 'MENTOR'
                          ? 'assignment-role-chip--mentor'
                          : row.response_role === 'PARTICIPANT'
                            ? 'assignment-role-chip--participant'
                            : 'assignment-role-chip--unknown'
                      }`}
                    >
                      {roleLabel(row.response_role)}
                    </span>
                  </td>
                  <td>{p.mentor_attended} / {p.mentor_attended_prior_year}</td>
                  <td>{p.participant_attended} / {p.participant_attended_prior_year}</td>
                  <td>
                    {recommendation
                      ? `#${recommendation.rank} (${recommendation.equity_score})`
                      : '—'}
                  </td>
                  <td>
                    {alreadyAssigned ? (
                      <div className="assignment-status">
                        {assignedRoles.map((role) => (
                          <span
                            key={`${row.member_id}-${role}`}
                            className={`assignment-role-chip ${role === 'MENTOR' ? 'assignment-role-chip--mentor' : 'assignment-role-chip--participant'}`}
                          >
                            Assigned {roleLabel(role)}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="members-row-actions">
                        <button className="btn btn--sm" onClick={() => assignMember(row.member_id, 'PARTICIPANT')}>Assign Participant</button>
                        <button className="btn btn--sm btn--outline" onClick={() => assignMember(row.member_id, 'MENTOR')}>Assign Volunteer</button>
                      </div>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <section className="card members-table-wrap">
        <h2>Current Assignments</h2>
        <table className="members-table">
          <thead>
            <tr><th>Name</th><th>Role</th><th>Role Y/PY</th><th>Total Y/PY</th><th>Attended</th><th>Action</th></tr>
          </thead>
          <tbody>
            {assignments.length === 0 ? (
              <tr><td colSpan={6}>No assignments yet.</td></tr>
            ) : assignments.map((row) => {
              const p = participationFor(row.member_id)
              const roleCurrent = row.role === 'MENTOR' ? p.mentor_attended : p.participant_attended
              const rolePrior = row.role === 'MENTOR' ? p.mentor_attended_prior_year : p.participant_attended_prior_year
              return (
                <tr key={row.assignment_id}>
                  <td>{row.first_name} {row.last_name}</td>
                  <td>{row.role}</td>
                  <td>{roleCurrent} / {rolePrior}</td>
                  <td>{p.events_attended} / {p.events_attended_prior_year}</td>
                  <td>
                    <input
                      type="checkbox"
                      checked={Boolean(row.attended)}
                      onChange={(e) => updateAttendance(row.assignment_id, e.target.checked)}
                    />
                  </td>
                  <td>
                    <div className="members-row-actions">
                      <button className="btn btn--sm btn--outline" onClick={() => void deleteAssignment(row.assignment_id)}>Remove</button>
                      <button className="btn btn--sm" onClick={() => void setRsvpNoAndRemove(row)}>RSVP No + Remove</button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>
    </div>
  )
}

export { EventAssignmentPage }
