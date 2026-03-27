import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ROLES } from '../authConfig';
import { useAuth } from '../hooks/useAuth';

interface NavItem {
  label: string;
  to: string;
  role?: string;
}

const NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard', to: '/dashboard' },
  { label: 'Preferences', to: '/preferences' },
  { label: 'Events', to: '/events' },
  { label: 'Calendar', to: '/calendar' },
  { label: 'Take a Vet Fishing', to: '/tavf' },
  { label: 'Members', to: '/members', role: ROLES.ADMIN },
  { label: 'Groups', to: '/groups', role: ROLES.ADMIN },
  { label: 'Import', to: '/import', role: ROLES.ADMIN },
  { label: 'Reports', to: '/reports', role: ROLES.ADMIN },
  { label: 'Templates', to: '/templates', role: ROLES.ADMIN },
  { label: 'Admin', to: '/admin', role: ROLES.ADMIN },
];

function TroutIcon({ size = 36 }: { size?: number }) {
  return (
    <svg width={size} height={Math.round(size * 0.6)} viewBox="0 0 64 38" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M8 19c4-8 16-14 28-12 6 1 12 4 18 8-2 1-5 3-7 5-4 4-10 7-18 8C18 30 10 26 8 19Z"
        fill="rgba(255,255,255,0.15)"
        stroke="rgba(255,255,255,0.4)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="44" cy="17" r="2" fill="rgba(255,255,255,0.6)" />
      <path
        d="M8 19c-3-5-5-12-4-16M8 19c-3 5-5 12-4 16"
        stroke="rgba(255,255,255,0.35)"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function isLinkActive(pathname: string, to: string): boolean {
  return pathname === to || pathname.startsWith(`${to}/`);
}

export default function Layout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  const roles = user?.roles ?? [];
  const visibleItems = NAV_ITEMS.filter((item) => !item.role || roles.includes(item.role as typeof ROLES[keyof typeof ROLES]));

  return (
    <div className="phw-layout">
      <nav className="phw-layout__nav">
        <div className="phw-layout__nav-inner">
          <Link to="/dashboard" className="phw-layout__brand">
            <TroutIcon />
            <div>
              <div className="phw-layout__brand-title">PHW Alpine</div>
              <div className="phw-layout__brand-subtitle">Colorado Chapter</div>
            </div>
          </Link>

          <div className="phw-layout__links" aria-label="Main navigation">
            {visibleItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  isActive || isLinkActive(location.pathname, item.to)
                    ? 'phw-layout__link phw-layout__link--active'
                    : 'phw-layout__link'
                }
              >
                {item.label}
              </NavLink>
            ))}
          </div>

          <div className="phw-layout__user">
            {user && (
              <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }} title={user.email}>
                {user.name}
              </span>
            )}
            <button className="btn btn--outline btn--sm" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </div>
      </nav>

      <main className="phw-layout__main">
        <Outlet />
      </main>

      <footer className="phw-layout__footer">
        <div className="phw-layout__footer-inner">
          <div>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Project Healing Waters Fly Fishing</p>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--phw-slate-600)', fontFamily: 'var(--phw-font-display)', fontStyle: 'italic' }}>
              Healing America's veterans through the therapeutic art of fly fishing
            </p>
          </div>
          <div style={{ display: 'inline-flex', gap: 14, alignItems: 'center' }}>
            <a href="https://projecthealingwaters.org" target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--phw-forest-600)', textDecoration: 'none' }}>
              PHW National
            </a>
            <a href="https://projecthealingwaters.org/privacy-policy/" target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--phw-slate-600)', textDecoration: 'none' }}>
              Privacy Policy
            </a>
            <span style={{ fontSize: 11, color: 'var(--phw-slate-400)' }}>
              {new Date().getFullYear()} Colorado Alpine Chapter
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}
