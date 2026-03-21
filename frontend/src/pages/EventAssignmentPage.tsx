import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { assignmentsApi, rsvpApi } from '../api/events'
import { membersApi } from '../api/members'

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

  async function assignMember(memberId: string, role: 'MENTOR' | 'PARTICIPANT') {
    if (!eventId) {
      return
    }
    try {
      await assignmentsApi.create(eventId, { member_id: memberId, role })
      const asns = await assignmentsApi.list(eventId)
      setAssignments(asns as Assignment[])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to assign member')
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
    rows.sort((a, b) => {
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
  }, [rsvps, participation, priorityRole])

  return (
    <div className="page">
      <h1 className="page__title">Event Assignments</h1>
      <p className="page__subtitle">Assign members from the RSVP pool and track attendance.</p>
      <button className="btn btn--outline btn--sm" onClick={() => navigate('/events')}>Back to Events</button>
      {error && <p className="members-error">{error}</p>}

      <section className="card members-table-wrap" style={{ marginTop: 12 }}>
        <h2>RSVP Pool</h2>
        <p className="page__subtitle" style={{ marginBottom: 8 }}>
          Priority sorted by lowest {priorityRole === 'MENTOR' ? 'mentor shifts' : 'participant attendance'} first.
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <button className={`btn btn--sm ${priorityRole === 'PARTICIPANT' ? '' : 'btn--outline'}`} onClick={() => setPriorityRole('PARTICIPANT')}>
            Prioritize Participant Role
          </button>
          <button className={`btn btn--sm ${priorityRole === 'MENTOR' ? '' : 'btn--outline'}`} onClick={() => setPriorityRole('MENTOR')}>
            Prioritize Mentor Role
          </button>
        </div>
        <table className="members-table">
          <thead>
            <tr><th>Name</th><th>Response</th><th>Mentor Y/PY</th><th>Participant Y/PY</th><th>Assign</th></tr>
          </thead>
          <tbody>
            {rankedRsvps.length === 0 ? (
              <tr><td colSpan={5}>No RSVP rows to assign.</td></tr>
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
              return (
                <tr key={`${row.member_id}-${row.response}`}>
                  <td>{name || row.member_id}</td>
                  <td>{row.response}</td>
                  <td>{p.mentor_attended} / {p.mentor_attended_prior_year}</td>
                  <td>{p.participant_attended} / {p.participant_attended_prior_year}</td>
                  <td>
                    {alreadyAssigned ? 'Assigned' : (
                      <>
                        <button className="btn btn--sm" onClick={() => assignMember(row.member_id, 'PARTICIPANT')}>Assign Participant</button>
                        <button className="btn btn--sm btn--outline" onClick={() => assignMember(row.member_id, 'MENTOR')}>Assign Mentor</button>
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
