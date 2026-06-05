import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ROLES } from '../authConfig';
import { rootApi } from '../api/root';
import { useTenantContext } from '../contexts/TenantContext';
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
  const { user, logout, canCreateTavfPostings } = useAuth();
  const { activeTenant, tenants, selectTenant } = useTenantContext();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isAdminMenuOpen, setIsAdminMenuOpen] = useState(false);
  const [isRootAdmin, setIsRootAdmin] = useState(false);
  const adminMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setIsMenuOpen(false);
    setIsAdminMenuOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!isAdminMenuOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (adminMenuRef.current?.contains(target)) {
        return;
      }
      setIsAdminMenuOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsAdminMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isAdminMenuOpen]);

  useEffect(() => {
    let active = true;

    if (!user) {
      setIsRootAdmin(false);
      return () => { active = false; };
    }

    rootApi.getSession()
      .then((session) => {
        if (!active) {
          return;
        }
        setIsRootAdmin(Boolean(session.is_root));
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setIsRootAdmin(false);
      });

    return () => { active = false; };
  }, [user]);

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  const roles = user?.roles ?? [];
  const isDemoTenant = Boolean(activeTenant?.is_demo || activeTenant?.slug?.toLowerCase().includes('demo'));
  const canAccessTavf = canCreateTavfPostings();
  const branding = activeTenant?.branding;
  const tenantDisplayName = activeTenant?.display_name ?? 'Colorado Alpine Program';
  const tenantShortName = branding?.org_short_name ?? tenantDisplayName;
  const tenantLogoUrl = isDemoTenant
    ? '/branding/phw-colorado-alpine-orange.png'
    : (branding?.logo_url || '/branding/PHWTroutLogoSagebrush-1.png');
  const tenantAccent = branding?.primary_color ?? '#1f5f4a';
  const eligibleTenants = useMemo(() => tenants.filter((tenant) => {
    if (!tenant.expires_at) {
      return true;
    }
    const expiresAt = Date.parse(tenant.expires_at);
    return Number.isNaN(expiresAt) || expiresAt > Date.now();
  }), [tenants]);
  const canSwitchTenant = eligibleTenants.length > 1;
  const visibleItems = NAV_ITEMS
    .filter((item) => !item.role || roles.includes(item.role as typeof ROLES[keyof typeof ROLES]))
    .filter((item) => item.to !== '/tavf' || canAccessTavf);

  const corePaths = new Set(['/dashboard', '/preferences', '/events', '/calendar', '/tavf']);
  const coreItems = visibleItems.filter((item) => corePaths.has(item.to));
  const adminItems = visibleItems.filter((item) => !corePaths.has(item.to));
  const managementItems = isRootAdmin ? [...adminItems, { label: 'Root', to: '/root' }] : adminItems;
  const isManagementRouteActive = managementItems.some((item) => isLinkActive(location.pathname, item.to));

  return (
    <div className={`phw-layout${isDemoTenant ? ' phw-layout--demo' : ''}`}>
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
              <div className="phw-layout__brand-title">{isDemoTenant ? 'Alpine Events Demo' : 'Alpine Events'}</div>
              <div className="phw-layout__brand-subtitle">{tenantDisplayName}</div>
            </div>
          </Link>

          <button
            className="phw-layout__menu-toggle"
            type="button"
            aria-expanded={isMenuOpen}
            aria-controls="phw-primary-navigation"
            onClick={() => setIsMenuOpen((current) => !current)}
          >
            Menu
          </button>

          <div
            id="phw-primary-navigation"
            className={`phw-layout__links${isMenuOpen ? ' phw-layout__links--open' : ''}`}
          >
            {coreItems.map((item) => (
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
            <div className="phw-layout__user-meta">
              {user && (
                <span className="phw-layout__username" title={user.email}>
                  {user.name}
                </span>
              )}
            </div>
            <div className="phw-layout__user-actions">
              {managementItems.length > 0 && (
                <div className="phw-layout__admin-menu" ref={adminMenuRef}>
                  <button
                    type="button"
                    className={`phw-layout__admin-menu-toggle${isManagementRouteActive ? ' phw-layout__admin-menu-toggle--active' : ''}`}
                    aria-expanded={isAdminMenuOpen}
                    aria-controls="phw-management-menu"
                    onClick={() => setIsAdminMenuOpen((current) => !current)}
                  >
                    <span className="phw-layout__admin-menu-icon" aria-hidden="true">≡</span>
                    <span>Manage</span>
                  </button>
                  <div
                    id="phw-management-menu"
                    className={`phw-layout__admin-menu-panel${isAdminMenuOpen ? ' phw-layout__admin-menu-panel--open' : ''}`}
                  >
                    {managementItems.map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        className={({ isActive }) =>
                          isActive || isLinkActive(location.pathname, item.to)
                            ? 'phw-layout__admin-menu-link phw-layout__admin-menu-link--active'
                            : 'phw-layout__admin-menu-link'
                        }
                      >
                        {item.label}
                      </NavLink>
                    ))}
                  </div>
                </div>
              )}

              {canSwitchTenant && (
                <label className="phw-layout__tenant-switcher">
                  <span className="phw-layout__tenant-switcher-label">Operate as</span>
                  <select
                    className="members-input"
                    value={activeTenant?.tenant_id ?? ''}
                    onChange={(event) => selectTenant(event.target.value)}
                  >
                    {eligibleTenants.map((tenant) => (
                      <option key={tenant.tenant_id} value={tenant.tenant_id}>
                        {tenant.display_name}{tenant.is_demo ? ' (Demo)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button className="btn btn--outline btn--sm" type="button" onClick={handleLogout}>
                Sign out
              </button>
            </div>
          </div>
        </div>
      </nav>

      {isDemoTenant && (
        <div className="phw-layout__demo-banner" role="status" aria-live="polite">
          DEMO INSTANCE · NON-PRODUCTION · SAFE FOR TRAINING AND WALKTHROUGHS
        </div>
      )}

      <main id="main-content" className="phw-layout__main" tabIndex={-1}>
        <Outlet />
      </main>

      <footer className="phw-layout__footer">
        <div className="phw-layout__footer-inner">
          <div>
            <div className="phw-footer__brand">
              <img
                className="phw-footer__logo"
                src={tenantLogoUrl}
                alt={`${tenantShortName} logo`}
                onError={(e) => { e.currentTarget.style.display = 'none'; }}
              />
              <p className="phw-footer__name">{tenantShortName}</p>
            </div>
            <p className="phw-footer__tagline">
              Healing America's veterans through the therapeutic art of fly fishing
            </p>
            <p className="phw-footer__credit">
              &copy; {new Date().getFullYear()} {tenantDisplayName}
            </p>
            <p className="phw-footer__accessibility">
              Accessibility notice: PHW Alpine Events aims to conform to WCAG 2.1 AA. If you need assistance accessing any feature, email{' '}
              <a href="mailto:accessibility@phwcoloradoalpine.org">accessibility@phwcoloradoalpine.org</a>.
            </p>
          </div>
          <div className="phw-footer__links">
            <a
              href="https://projecthealingwaters.org"
              target="_blank"
              rel="noreferrer"
              className="phw-footer__link phw-footer__link--accent"
              style={{ color: tenantAccent }}
            >
              PHW National
            </a>
            <Link to="/privacy" className="phw-footer__link">Privacy Policy</Link>
            <Link to="/terms" className="phw-footer__link">Terms</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
