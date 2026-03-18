import { NavLink, Outlet } from 'react-router-dom';
import './Layout.css';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard', end: true },
  { to: '/members', label: 'Members' },
  { to: '/groups', label: 'Groups' },
  { to: '/events', label: 'Events' },
  { to: '/import', label: 'Import' },
  { to: '/reports', label: 'Reports' },
];

export default function Layout() {
  return (
    <div className="layout">
      <header className="layout-header">
        <span className="layout-logo">Project Healing Waters Alpine Events</span>
      </header>
      <div className="layout-body">
        <nav className="layout-nav">
          <ul>
            {NAV_ITEMS.map(({ to, label, end }) => (
              <li key={to}>
                <NavLink
                  to={to}
                  end={end}
                  className={({ isActive }) => (isActive ? 'active' : undefined)}
                >
                  {label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <main className="layout-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
