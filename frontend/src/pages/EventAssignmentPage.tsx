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
  const [participation, setParticipation] = useState<Record<string, { events_attended: number; events_attended_prior_year: number }>>({})
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
        const uniqueMemberIds = Array.from(new Set(asns.map((row) => row.member_id)))
        const participationRows = await Promise.all(uniqueMemberIds.map(async (memberId) => {
          try {
            const row = await membersApi.participation(memberId)
            return [memberId, { events_attended: row.events_attended, events_attended_prior_year: row.events_attended_prior_year }] as const
          } catch {
            return [memberId, { events_attended: 0, events_attended_prior_year: 0 }] as const
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

  return (
    <div className="page">
      <h1 className="page__title">Event Assignments</h1>
      <p className="page__subtitle">Assign members from the RSVP pool and track attendance.</p>
      <button className="btn btn--outline btn--sm" onClick={() => navigate('/events')}>Back to Events</button>
      {error && <p className="members-error">{error}</p>}

      <section className="card members-table-wrap" style={{ marginTop: 12 }}>
        <h2>RSVP Pool</h2>
        <table className="members-table">
          <thead>
            <tr><th>Name</th><th>Response</th><th>Assign</th></tr>
          </thead>
          <tbody>
            {rsvps.length === 0 ? (
              <tr><td colSpan={3}>No RSVP rows to assign.</td></tr>
            ) : rsvps.map((row) => {
              const name = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim()
              const alreadyAssigned = assignedMemberIds.has(row.member_id)
              return (
                <tr key={`${row.member_id}-${row.response}`}>
                  <td>{name || row.member_id}</td>
                  <td>{row.response}</td>
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
            <tr><th>Name</th><th>Role</th><th>Participation</th><th>Attended</th></tr>
          </thead>
          <tbody>
            {assignments.length === 0 ? (
              <tr><td colSpan={4}>No assignments yet.</td></tr>
            ) : assignments.map((row) => {
              const p = participation[row.member_id] ?? { events_attended: 0, events_attended_prior_year: 0 }
              return (
                <tr key={row.assignment_id}>
                  <td>{row.first_name} {row.last_name}</td>
                  <td>{row.role}</td>
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
