import { useEffect, useMemo, useState } from 'react'
import { eventsApi } from '../api/events'
import { membersApi } from '../api/members'
import { useAuth } from '../hooks/useAuth'

function DashboardPage() {
  const { user, isAdmin } = useAuth()
  const [upcoming, setUpcoming] = useState<Array<{ event_id: string; title: string; event_date: string; location: string | null }>>([])
  const [myRsvps, setMyRsvps] = useState<Array<{ event_id: string; title: string; event_date: string; response: string }>>([])
  const [stats, setStats] = useState<{ totalMembers: number; totalEventsThisYear: number; upcomingEvents: number }>({
    totalMembers: 0,
    totalEventsThisYear: 0,
    upcomingEvents: 0,
  })

  const nowIso = useMemo(() => new Date().toISOString(), [])

  useEffect(() => {
    let active = true
    eventsApi.list('published').then((rows) => {
      if (!active) {
        return
      }
      const next = rows
        .filter((event) => event.event_date >= nowIso)
        .sort((a, b) => new Date(a.event_date).getTime() - new Date(b.event_date).getTime())
        .slice(0, 5)
        .map((event) => ({
          event_id: event.event_id,
          title: event.title,
          event_date: event.event_date,
          location: event.location,
        }))
      setUpcoming(next)

      if (isAdmin()) {
        const thisYear = new Date().getFullYear()
        const totalEventsThisYear = rows.filter((event) => new Date(event.event_date).getFullYear() === thisYear).length
        setStats((cur) => ({ ...cur, totalEventsThisYear, upcomingEvents: next.length }))
      }
    }).catch(() => {
      if (active) {
        setUpcoming([])
      }
    })

    if (user?.id) {
      membersApi.rsvps(user.id)
        .then((rows) => {
          if (!active) {
            return
          }
          setMyRsvps(rows.slice(0, 5).map((row) => ({
            event_id: row.event_id,
            title: row.title,
            event_date: row.event_date,
            response: row.response,
          })))
        })
        .catch(() => {
          if (active) {
            setMyRsvps([])
          }
        })
    }

    if (isAdmin()) {
      membersApi.list({ page: 1, pageSize: 1, isActive: true })
        .then((res) => {
          if (active) {
            setStats((cur) => ({ ...cur, totalMembers: res.total }))
          }
        })
        .catch(() => {
          if (active) {
            setStats((cur) => ({ ...cur, totalMembers: 0 }))
          }
        })
    }

    return () => {
      active = false
    }
  }, [isAdmin, nowIso, user?.id])

  return (
    <div className="page">
      <h1 className="page__title">Dashboard</h1>
      <p className="page__subtitle">Welcome back{user ? `, ${user.name}` : ''}.</p>

      <div className="card-grid">
        <div className="card">
          <h2 className="card__title">Upcoming Events</h2>
          {upcoming.length === 0 ? <p className="card__body">No upcoming published events.</p> : (
            <ul>
              {upcoming.map((event) => (
                <li key={event.event_id}>
                  {new Date(event.event_date).toLocaleDateString()} - {event.title}{event.location ? ` (${event.location})` : ''}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2 className="card__title">My RSVPs</h2>
          {myRsvps.length === 0 ? <p className="card__body">No RSVP records available for your member profile.</p> : (
            <ul>
              {myRsvps.map((row) => (
                <li key={`${row.event_id}-${row.response}`}>
                  {new Date(row.event_date).toLocaleDateString()} - {row.title} [{row.response}]
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="card">
          <h2 className="card__title">Quick Stats</h2>
          {isAdmin() ? (
            <ul>
              <li>Total active members: {stats.totalMembers}</li>
              <li>Total events this year: {stats.totalEventsThisYear}</li>
              <li>Upcoming events: {stats.upcomingEvents}</li>
            </ul>
          ) : (
            <p className="card__body">Admin stats are only visible to administrators.</p>
          )}
        </div>
      </div>
    </div>
  )
}

export { DashboardPage }