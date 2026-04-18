import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { assignmentsApi, rsvpApi } from '../api/events'
import { membersApi } from '../api/members'
import type { AssignmentRecommendationRow } from '../api/events'

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

function EventAssignmentPage() {
  const navigate = useNavigate()
  const { id } = useParams<{ id: string }>()
  const eventId = id ?? ''
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [rsvps, setRsvps] = useState<Array<{ member_id: string; first_name?: string; last_name?: string; response: string }>>([])
  const [participation, setParticipation] = useState<Record<string, {
    events_attended: number
    events_attended_prior_year: number
    mentor_attended: number
    mentor_attended_prior_year: number
    participant_attended: number
    participant_attended_prior_year: number
  }>>({})
  const [priorityRole, setPriorityRole] = useState<'MENTOR' | 'PARTICIPANT'>('PARTICIPANT')
  const [recommendations, setRecommendations] = useState<AssignmentRecommendationRow[]>([])
  const [recommendationsLoading, setRecommendationsLoading] = useState(false)
  const [manualSearch, setManualSearch] = useState('')
  const [manualResults, setManualResults] = useState<MemberSearchRow[]>([])
  const [manualLoading, setManualLoading] = useState(false)
  const [closingAtCapacity, setClosingAtCapacity] = useState(false)
  const [closeAtCapacityNotice, setCloseAtCapacityNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const assignedMemberIds = useMemo(() => new Set(assignments.map((a) => a.member_id)), [assignments])

  useEffect(() => {
    if (!eventId) {
      return
    }
    let active = true
    Promise.all([
      assignmentsApi.list(eventId),
      rsvpApi.list(eventId),
    ])
      .then(async ([asns, eventRsvps]) => {
        if (!active) {
          return
        }
        setAssignments(asns as Assignment[])
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
            return [memberId, {
              events_attended: 0,
              events_attended_prior_year: 0,
              mentor_attended: 0,
              mentor_attended_prior_year: 0,
              participant_attended: 0,
              participant_attended_prior_year: 0,
            }] as const
          }
        }))
        if (active) {
          setParticipation(Object.fromEntries(participationRows))
        }
      })
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
      const asns = await assignmentsApi.list(eventId)
      setAssignments(asns as Assignment[])
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
      setCloseAtCapacityNotice(
        `${result.message} Volunteer cap: ${result.event.mentor_capacity ?? 0}. Participant cap: ${result.event.participant_capacity ?? 0}.`
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
      const asns = await assignmentsApi.list(eventId)
      setAssignments(asns as Assignment[])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update attendance')
    }
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

      const aPart = participation[a.member_id] ?? {
        events_attended: 0,
        events_attended_prior_year: 0,
        mentor_attended: 0,
        mentor_attended_prior_year: 0,
        participant_attended: 0,
        participant_attended_prior_year: 0,
      }
      const bPart = participation[b.member_id] ?? {
        events_attended: 0,
        events_attended_prior_year: 0,
        mentor_attended: 0,
        mentor_attended_prior_year: 0,
        participant_attended: 0,
        participant_attended_prior_year: 0,
      }

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

  return (
    <div className="page">
      <h1 className="page__title">Event Assignments</h1>
      <p className="page__subtitle">Assign members from the RSVP pool and track attendance.</p>
      <button className="btn btn--outline btn--sm" onClick={() => navigate('/events')}>Back to Events</button>
      {error && <p className="members-error">{error}</p>}

      <section className="card members-table-wrap" style={{ marginTop: 12 }}>
        <h2>Capacity Controls</h2>
        <p className="page__subtitle" style={{ marginBottom: 8 }}>
          Lock this event at its current assigned/confirmed seats. Future "Yes" RSVP submissions will be stored as waitlist when full.
        </p>
        <button className="btn btn--sm" disabled={closingAtCapacity} onClick={() => void closeEventAtCapacity()}>
          {closingAtCapacity ? 'Closing…' : 'Close Event At Capacity'}
        </button>
        {closeAtCapacityNotice && <p className="members-loading" style={{ marginTop: 8 }}>{closeAtCapacityNotice}</p>}
      </section>

      <section className="card members-table-wrap" style={{ marginTop: 12 }}>
        <h2>Manual Association</h2>
        <p className="page__subtitle" style={{ marginBottom: 8 }}>
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
          <table className="members-table" style={{ marginTop: 8 }}>
            <thead>
              <tr><th>Name</th><th>Email</th><th>Assign</th></tr>
            </thead>
            <tbody>
              {manualResults.map((member) => {
                const alreadyAssigned = assignedMemberIds.has(member.member_id)
                const name = `${member.first_name ?? ''} ${member.last_name ?? ''}`.trim()
                return (
                  <tr key={member.member_id}>
                    <td>{name || member.member_id}</td>
                    <td>{member.email}</td>
                    <td>
                      {alreadyAssigned ? 'Assigned' : (
                        <>
                          <button className="btn btn--sm" onClick={() => assignMember(member.member_id, 'PARTICIPANT')}>Assign Participant</button>
                          <button className="btn btn--sm btn--outline" onClick={() => assignMember(member.member_id, 'MENTOR')}>Assign Volunteer</button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      <section className="card members-table-wrap" style={{ marginTop: 12 }}>
        <h2>RSVP Pool</h2>
        <p className="page__subtitle" style={{ marginBottom: 8 }}>
          Priority sorted by lowest {priorityRole === 'MENTOR' ? 'volunteer shifts' : 'participant attendance'} first.
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
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
            <tr><th>Name</th><th>Response</th><th>Volunteer Y/PY</th><th>Participant Y/PY</th><th>Equity</th><th>Assign</th></tr>
          </thead>
          <tbody>
            {rankedRsvps.length === 0 ? (
              <tr><td colSpan={6}>No RSVP rows to assign.</td></tr>
            ) : rankedRsvps.map((row) => {
              const name = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim()
              const alreadyAssigned = assignedMemberIds.has(row.member_id)
              const p = participation[row.member_id] ?? {
                events_attended: 0,
                events_attended_prior_year: 0,
                mentor_attended: 0,
                mentor_attended_prior_year: 0,
                participant_attended: 0,
                participant_attended_prior_year: 0,
              }
              const recommendation = recommendationByMember.get(row.member_id)
              return (
                <tr key={`${row.member_id}-${row.response}`}>
                  <td>{name || row.member_id}</td>
                  <td>{row.response}</td>
                  <td>{p.mentor_attended} / {p.mentor_attended_prior_year}</td>
                  <td>{p.participant_attended} / {p.participant_attended_prior_year}</td>
                  <td>
                    {recommendation
                      ? `#${recommendation.rank} (${recommendation.equity_score})`
                      : '—'}
                  </td>
                  <td>
                    {alreadyAssigned ? 'Assigned' : (
                      <>
                        <button className="btn btn--sm" onClick={() => assignMember(row.member_id, 'PARTICIPANT')}>Assign Participant</button>
                        <button className="btn btn--sm btn--outline" onClick={() => assignMember(row.member_id, 'MENTOR')}>Assign Volunteer</button>
                      </>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      <section className="card members-table-wrap" style={{ marginTop: 12 }}>
        <h2>Current Assignments</h2>
        <table className="members-table">
          <thead>
            <tr><th>Name</th><th>Role</th><th>Role Y/PY</th><th>Total Y/PY</th><th>Attended</th></tr>
          </thead>
          <tbody>
            {assignments.length === 0 ? (
              <tr><td colSpan={5}>No assignments yet.</td></tr>
            ) : assignments.map((row) => {
              const p = participation[row.member_id] ?? {
                events_attended: 0,
                events_attended_prior_year: 0,
                mentor_attended: 0,
                mentor_attended_prior_year: 0,
                participant_attended: 0,
                participant_attended_prior_year: 0,
              }
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
