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
      <a href="#main-content" className="phw-skip-link">Skip to main content</a>
      <nav className="phw-layout__nav">
        <div className="phw-layout__nav-inner">
          <Link to="/dashboard" className="phw-layout__brand">
            <img
              className="phw-layout__brand-logo"
              src="/branding/PHWLogoHorizontal_Light.png"
              alt="Project Healing Waters"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            <div className="phw-layout__brand-text">
              <div className="phw-layout__brand-title">Alpine Events</div>
              <div className="phw-layout__brand-subtitle">Colorado Chapter</div>
            </div>
          </Link>

          <div className="phw-layout__links">
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
              <span className="phw-layout__username" title={user.email}>
                {user.name}
              </span>
            )}
            <button className="btn btn--outline btn--sm" onClick={handleLogout}>
              Sign out
            </button>
          </div>
        </div>
      </nav>

      <main id="main-content" className="phw-layout__main" tabIndex={-1}>
        <Outlet />
      </main>

      <footer className="phw-layout__footer">
        <div className="phw-layout__footer-inner">
          <div>
            <div className="phw-footer__brand">
              <img
                className="phw-footer__logo"
                src="/branding/PHWTroutLogoSagebrush-1.png"
                alt="PHW Trout"
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
              <p className="phw-footer__name">Project Healing Waters Fly Fishing</p>
            </div>
            <p className="phw-footer__tagline">
              Healing America's veterans through the therapeutic art of fly fishing
            </p>
            <p className="phw-footer__credit">
              &copy; {new Date().getFullYear()} Colorado Alpine Chapter
            </p>
            <p className="phw-footer__accessibility">
              Accessibility notice: PHW Alpine Events aims to conform to WCAG 2.1 AA. If you need assistance accessing any feature, email{' '}
              <a href="mailto:accessibility@phwcoloradoalpine.org">accessibility@phwcoloradoalpine.org</a>.
            </p>
          </div>
          <div className="phw-footer__links">
            <a href="https://projecthealingwaters.org" target="_blank" rel="noreferrer" className="phw-footer__link phw-footer__link--accent">
              PHW National
            </a>
            <a href="https://projecthealingwaters.org/privacy-policy/" target="_blank" rel="noreferrer" className="phw-footer__link">
              Privacy Policy
            </a>
            <Link to="/terms" className="phw-footer__link">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
