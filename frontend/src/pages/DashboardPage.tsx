import { useAuth } from '../hooks/useAuth';

export function DashboardPage() {
  const { user } = useAuth();

  return (
    <div className="page">
      <h1 className="page__title">Dashboard</h1>
      <p className="page__subtitle">
        Welcome back{user ? `, ${user.name}` : ''}!
      </p>

      <div className="card-grid">
        <div className="card">
          <h2 className="card__title">Upcoming Events</h2>
          <p className="card__body">Events list coming soon.</p>
        </div>
        <div className="card">
          <h2 className="card__title">My RSVPs</h2>
          <p className="card__body">Your RSVPs will appear here.</p>
        </div>
        <div className="card">
          <h2 className="card__title">Announcements</h2>
          <p className="card__body">Chapter announcements coming soon.</p>
        </div>
      </div>
    </div>
  );
}
