import { useAuth } from '../hooks/useAuth'

function DashboardPage() {
  const { user } = useAuth()

  return (
    <div className="page">
      <h1 className="page__title">Dashboard</h1>
      <p className="page__subtitle">Welcome back{user ? `, ${user.name}` : ''}.</p>

      <div className="card-grid">
        <div className="card">
          <h2 className="card__title">Upcoming Events</h2>
          <p className="card__body">The event feed will be connected in the next feature pass.</p>
        </div>
        <div className="card">
          <h2 className="card__title">My RSVPs</h2>
          <p className="card__body">Your responses and assignments will appear here.</p>
        </div>
        <div className="card">
          <h2 className="card__title">Operations</h2>
          <p className="card__body">Admin and member workflows are now scaffolded behind protected routes.</p>
        </div>
      </div>
    </div>
  )
}

export { DashboardPage }