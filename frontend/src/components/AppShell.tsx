import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { ROLES } from '../authConfig';

function navClass({ isActive }: { isActive: boolean }) {
  return isActive ? 'app-nav__link app-nav__link--active' : 'app-nav__link';
}

function primaryRole(roles: string[]): string | null {
  if (roles.includes(ROLES.ADMIN)) return ROLES.ADMIN;
  if (roles.includes(ROLES.STAFF)) return ROLES.STAFF;
  if (roles.includes(ROLES.MEMBER)) return ROLES.MEMBER;
  return roles[0] ?? null;
}

export function AppShell() {
  const { user, logout, isAdmin, isStaff } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  const displayRole = user ? primaryRole(user.roles) : null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__brand">
          <span className="app-header__logo">⛷</span>
          <span className="app-header__title">PHW Alpine Events</span>
        </div>

        <nav className="app-nav" aria-label="Main navigation">
          <NavLink to="/dashboard" className={navClass}>Dashboard</NavLink>
          <NavLink to="/events" className={navClass}>Events</NavLink>
          {isStaff() && (
            <NavLink to="/members" className={navClass}>Members</NavLink>
          )}
          {isAdmin() && (
            <NavLink to="/admin" className={navClass}>Admin</NavLink>
          )}
        </nav>

        <div className="app-header__user">
          {user && (
            <span className="app-header__username" title={user.email}>
              {user.name}
              {displayRole && (
                <span className="app-header__role">{displayRole}</span>
              )}
            </span>
          )}
          <button className="btn btn--outline btn--sm" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>

      <main className="app-main">
        <Outlet />
      </main>

      <footer className="app-footer">
        <p>© {new Date().getFullYear()} PHW – Colorado Alpine Chapter</p>
      </footer>
    </div>
  );
}
