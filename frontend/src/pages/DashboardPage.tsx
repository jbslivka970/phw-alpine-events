import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { colors, fonts, rsvpStyles } from '../styles/theme';
import { eventsApi, type EventRecord } from '../api/events';
import { membersApi } from '../api/members';
import tavfApi, { type TavfPosting } from '../api/tavf';
import { useAuth } from '../hooks/useAuth';
import EmptyState from '../components/EmptyState';
import CapacityBadge from '../components/CapacityBadge';
import LoadingSkeleton from '../components/LoadingSkeleton';
import { toUserErrorMessage } from '../utils/errorMessage';

type DashboardRsvp = {
  event_id: string;
  title: string;
  event_date: string;
  response: 'yes' | 'no' | 'maybe' | 'waitlist';
};

type DashboardStats = {
  totalMembers: number;
  totalEventsThisYear: number;
  upcomingEvents: number;
  totalRsvps: number;
};

const HERO_PHOTO = '/PHW Photos/PHW-Hartsel25-1410.jpg';

const FALLBACK_GALLERY_PHOTOS = [
  '/PHW Photos/PHW-Hartsel25-1410.jpg',
  '/PHW Photos/PHW-Hartsel25-1247.jpg',
  '/PHW Photos/PHW-Hartsel25-1429.jpg',
  '/PHW Photos/tarryall Creek fisherman.jpg',
];

const GALLERY_PHOTOS = [
  '/PHW Photos/IMG_7247.JPG',
  '/PHW Photos/IMG_7251.JPG',
  '/PHW Photos/IMG_7264.JPG',
  '/PHW Photos/IMG_7266.JPG',
];

const ONBOARDING_KEY_PREFIX = 'phw-onboarding-dismissed';

function HeroBanner({ userName }: { userName?: string }) {
  return (
    <div className="phw-hero phw-stagger phw-stagger-1">
      <img
        className="phw-hero__image"
        src={HERO_PHOTO}
        alt="Colorado fly fishing"
        loading="eager"
      />
      <div className="phw-hero__overlay" />
      <div className="phw-hero__content">
        <p className="phw-hero__eyebrow">Colorado Alpine Chapter</p>
        <h1 className="phw-hero__title">
          Welcome back{userName ? `, ${userName}` : ''}
        </h1>
        <p className="phw-hero__subtitle">
          The river is always there, waiting.
        </p>
      </div>
    </div>
  );
}

function PhotoStrip() {
  return (
    <div className="phw-photo-strip phw-stagger phw-stagger-2">
      {GALLERY_PHOTOS.map((src, i) => (
        <div key={i} className="phw-photo-strip__item">
          <img
            src={src}
            alt={`PHW event ${i + 1}`}
            loading="lazy"
            onError={(event) => {
              const fallbackSrc = FALLBACK_GALLERY_PHOTOS[i % FALLBACK_GALLERY_PHOTOS.length];
              if (event.currentTarget.src.endsWith(fallbackSrc)) {
                event.currentTarget.style.opacity = '0';
                return;
              }
              event.currentTarget.src = fallbackSrc;
            }}
          />
        </div>
      ))}
    </div>
  );
}

function StatCard({ label, value, color, delay }: { label: string; value: string | number; color?: string; delay: number }) {
  return (
    <div className={`phw-stat-card phw-stagger phw-stagger-${delay}`}>
      <p style={{ margin: '0 0 6px', fontSize: 11, color: colors.slate[500], textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>
        {label}
      </p>
      <p style={{ margin: 0, fontSize: 28, fontWeight: 800, color: color ?? colors.slate[950], lineHeight: 1.1 }}>
        {value}
      </p>
    </div>
  );
}

function DashboardPage() {
  const { user, isAdmin, canCreateEvents } = useAuth();
  const navigate = useNavigate();
  const isAdminUser = isAdmin();
  const canManageEvents = isAdminUser || canCreateEvents();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [eventActionError, setEventActionError] = useState<string | null>(null);
  const [eventEmailingId, setEventEmailingId] = useState<string | null>(null);
  const [upcoming, setUpcoming] = useState<EventRecord[]>([]);
  const [myRsvps, setMyRsvps] = useState<DashboardRsvp[]>([]);
  const [openPostings, setOpenPostings] = useState<TavfPosting[]>([]);
  const [stats, setStats] = useState<DashboardStats>({
    totalMembers: 0,
    totalEventsThisYear: 0,
    upcomingEvents: 0,
    totalRsvps: 0,
  });
  const [showOnboarding, setShowOnboarding] = useState(false);

  const now = useMemo(() => new Date(), []);

  function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  useEffect(() => {
    let active = true;

    async function loadDashboard() {
      try {
        setLoadError(null);
        const events = await eventsApi.list('published');
        if (!active) return;

        const next = events
          .filter((event) => new Date(event.event_date).getTime() >= now.getTime())
          .sort((a, b) => new Date(a.event_date).getTime() - new Date(b.event_date).getTime())
          .slice(0, 5);
        setUpcoming(next);

        const thisYear = new Date().getFullYear();
        const totalEventsThisYear = events.filter((event) => new Date(event.event_date).getFullYear() === thisYear).length;
        const totalRsvps = events.reduce((sum, event) => sum + (event.yes_count ?? 0), 0);

        setStats((cur) => ({
          ...cur,
          totalEventsThisYear,
          totalRsvps,
          upcomingEvents: next.length,
        }));

        let resolvedMemberId: string | null = null;
        if (user?.email) {
          try {
            const memberList = await membersApi.list({ page: 1, pageSize: 10, search: user.email });
            const normalizedEmail = user.email.trim().toLowerCase();
            resolvedMemberId = memberList.data.find((candidate) => candidate.email.trim().toLowerCase() === normalizedEmail)?.member_id ?? null;
          } catch {
            resolvedMemberId = null;
          }
        }
        if (!resolvedMemberId && user?.id && isUuid(user.id)) {
          resolvedMemberId = user.id;
        }

        if (resolvedMemberId) {
          try {
            const responses = await membersApi.rsvps(resolvedMemberId);
            if (active) {
              setMyRsvps(
                responses.slice(0, 4).map((row) => ({
                  event_id: row.event_id,
                  title: row.title,
                  event_date: row.event_date,
                  response: row.response,
                }))
              );
            }
          } catch {
            if (active) setMyRsvps([]);
          }
        } else if (active) {
          setMyRsvps([]);
        }

        try {
          const postings = await tavfApi.listPostings('open');
          if (active) setOpenPostings(postings.slice(0, 4));
        } catch {
          if (active) setOpenPostings([]);
        }

        if (isAdminUser) {
          try {
            const memberList = await membersApi.list({ page: 1, pageSize: 1, isActive: true });
            if (active) setStats((cur) => ({ ...cur, totalMembers: memberList.total }));
          } catch {
            if (active) setStats((cur) => ({ ...cur, totalMembers: 0 }));
          }
        }
      } catch (error) {
        if (active) {
          setLoadError(toUserErrorMessage(error, 'Unable to load dashboard data right now.'));
          setUpcoming([]);
          setMyRsvps([]);
          setOpenPostings([]);
          setStats({
            totalMembers: 0,
            totalEventsThisYear: 0,
            upcomingEvents: 0,
            totalRsvps: 0,
          });
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadDashboard();
    return () => {
      active = false;
    };
  }, [isAdminUser, now, user?.email, user?.id]);

  useEffect(() => {
    const identity = user?.id ?? user?.email;
    if (!identity) {
      setShowOnboarding(false);
      return;
    }

    const key = `${ONBOARDING_KEY_PREFIX}:${identity}`;
    try {
      const dismissed = window.localStorage.getItem(key) === '1';
      setShowOnboarding(!dismissed);
    } catch {
      // Some mobile Safari privacy modes can throw on storage access.
      setShowOnboarding(true);
    }
  }, [user?.email, user?.id]);

  function dismissOnboarding(): void {
    const identity = user?.id ?? user?.email;
    if (identity) {
      try {
        window.localStorage.setItem(`${ONBOARDING_KEY_PREFIX}:${identity}`, '1');
      } catch {
        // Ignore storage failures and still dismiss for the current session.
      }
    }
    setShowOnboarding(false);
  }

  const displayName = user?.name?.split(' ')[0] ?? undefined;

  function parseDispositionFilename(headerValue: string | null): string | null {
    if (!headerValue) {
      return null;
    }
    const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(headerValue);
    if (utf8Match?.[1]) {
      return decodeURIComponent(utf8Match[1]);
    }
    const plainMatch = /filename="?([^";]+)"?/i.exec(headerValue);
    return plainMatch?.[1] ?? null;
  }

  function downloadBlobFile(blob: Blob, headers: Headers, fallbackFilename: string): void {
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const fromHeader = parseDispositionFilename(headers.get('content-disposition'));
    anchor.href = objectUrl;
    anchor.download = fromHeader ?? fallbackFilename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(objectUrl);
  }

  async function downloadEventIcs(event: EventRecord): Promise<void> {
    try {
      const { blob, headers } = await eventsApi.downloadIcs(event.event_id);
      downloadBlobFile(blob, headers, `event-${event.event_id}.ics`);
    } catch {
      setEventActionError('Unable to download event calendar file right now.');
    }
  }

  async function downloadEventReportCsv(event: EventRecord): Promise<void> {
    try {
      const { blob, headers } = await eventsApi.downloadReportCsv(event.event_id);
      downloadBlobFile(blob, headers, `event-report-${event.event_id}.csv`);
    } catch {
      setEventActionError('Unable to download event CSV report right now.');
    }
  }

  async function downloadEventReportPdf(event: EventRecord): Promise<void> {
    try {
      const { blob, headers } = await eventsApi.downloadReportPdf(event.event_id);
      downloadBlobFile(blob, headers, `event-report-${event.event_id}.pdf`);
    } catch {
      setEventActionError('Unable to download event PDF report right now.');
    }
  }

  async function emailEventRecord(event: EventRecord): Promise<void> {
    setEventEmailingId(event.event_id);
    try {
      await eventsApi.emailReport(event.event_id);
      setEventActionError(null);
    } catch {
      setEventActionError('Unable to email event record right now.');
    } finally {
      setEventEmailingId(null);
    }
  }

  return (
    <div className="phw-dashboard" style={{ maxWidth: 1040, margin: '0 auto' }}>
      <HeroBanner userName={displayName} />

      <PhotoStrip />

      {showOnboarding && (
        <div className="phw-onboarding-card phw-stagger phw-stagger-3">
          <div>
            <h2 className="phw-onboarding-card__title">Quick Start</h2>
            <p className="phw-onboarding-card__text">Set your communication preferences, RSVP to one event, and check TAVF opportunities.</p>
            <div className="phw-onboarding-card__actions">
              <Link to="/preferences" className="btn btn--outline btn--sm phw-action-pill">
                <span className="phw-action-pill__icon" aria-hidden="true">PF</span>
                <span className="phw-action-pill__label">Set Preferences</span>
              </Link>
              <Link to="/events" className="btn btn--outline btn--sm phw-action-pill">
                <span className="phw-action-pill__icon" aria-hidden="true">EV</span>
                <span className="phw-action-pill__label">Browse Events</span>
              </Link>
              <Link to="/tavf" className="btn btn--outline btn--sm phw-action-pill">
                <span className="phw-action-pill__icon" aria-hidden="true">TV</span>
                <span className="phw-action-pill__label">Open TAVF</span>
              </Link>
            </div>
          </div>
          <button className="btn btn--ghost btn--sm" onClick={dismissOnboarding}>Dismiss</button>
        </div>
      )}

      <div className="phw-dashboard__stats-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 14, marginBottom: '1.75rem' }}>
        <StatCard label="Members" value={isAdminUser ? stats.totalMembers : '–'} delay={3} />
        <StatCard label="Events YTD" value={stats.totalEventsThisYear} delay={4} />
        <StatCard label="Upcoming" value={stats.upcomingEvents} color={colors.forest[600]} delay={5} />
        <StatCard label="Yes RSVPs" value={stats.totalRsvps} color="#c46a28" delay={6} />
      </div>

      <div className="phw-stagger phw-stagger-7" style={{ marginBottom: '1.75rem' }}>
        <div className="phw-section-header">
          <h2 className="phw-section-title">Upcoming Events</h2>
          <Link to="/events" className="phw-section-link">View all &rarr;</Link>
        </div>

        {loadError && <p className="ui-notice ui-notice--error">{loadError}</p>}
        {eventActionError && <p className="ui-notice ui-notice--error">{eventActionError}</p>}

        {loading ? (
          <div className="phw-card" style={{ padding: '1.25rem' }}>
            <LoadingSkeleton lines={4} />
          </div>
        ) : upcoming.length === 0 ? (
          <div className="phw-card">
            <EmptyState
              variant="river"
              title="No upcoming events yet"
              description="Your next adventure on the water starts here."
              actionLabel={isAdminUser ? 'Create Event' : undefined}
              onAction={isAdminUser ? () => navigate('/events') : undefined}
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {upcoming.map((event, index) => {
              const totalSlots = event.capacity ?? 0;
              const filled = event.yes_count ?? 0;
              const stripe = totalSlots > 0 && filled >= totalSlots ? colors.alpine[600] : totalSlots > 0 && totalSlots - filled <= Math.ceil(totalSlots * 0.25) ? colors.golden[600] : colors.forest[600];

              return (
                <div key={event.event_id} className={`phw-stagger phw-stagger-${Math.min(index + 6, 8)}`}>
                  <div className="phw-event-card">
                    <div className="phw-event-card__stripe" style={{ background: stripe }} />
                    <div className="phw-event-card__body">
                      {event.photo_url && (
                        <img className="phw-event-card__photo" src={event.photo_url} alt={`${event.title} preview`} loading="lazy" />
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                          <Link to="/events" style={{ textDecoration: 'none', color: 'inherit' }}>{event.title}</Link>
                        </h3>
                        {totalSlots > 0 && <CapacityBadge totalSlots={totalSlots} filledSlots={filled} />}
                      </div>
                      <p style={{ margin: 0, fontSize: 13, color: colors.slate[600] }}>
                        {new Date(event.event_date).toLocaleDateString()} {event.location ? `· ${event.location}` : ''}
                      </p>
                      {event.description && (
                        <p style={{ margin: '6px 0 0', fontSize: 13, color: colors.slate[500], fontFamily: fonts.display, fontStyle: 'italic' }}>
                          {event.description}
                        </p>
                      )}
                      <div className="phw-event-actions" style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                        <button className="btn btn--outline btn--sm phw-event-action-pill" onClick={() => navigate('/events')}>
                          <span className="phw-event-action-pill__icon" aria-hidden="true">GO</span>
                          <span className="phw-event-action-pill__label">Open</span>
                        </button>
                        <button className="btn btn--outline btn--sm phw-event-action-pill" onClick={() => void downloadEventIcs(event)}>
                          <span className="phw-event-action-pill__icon" aria-hidden="true">IC</span>
                          <span className="phw-event-action-pill__label">ICS</span>
                        </button>
                        {canManageEvents && (
                          <>
                            <button className="btn btn--outline btn--sm phw-event-action-pill" disabled={event.status !== 'completed'} onClick={() => void downloadEventReportCsv(event)}>
                              <span className="phw-event-action-pill__icon" aria-hidden="true">CV</span>
                              <span className="phw-event-action-pill__label">CSV</span>
                            </button>
                            <button className="btn btn--outline btn--sm phw-event-action-pill" disabled={event.status !== 'completed'} onClick={() => void downloadEventReportPdf(event)}>
                              <span className="phw-event-action-pill__icon" aria-hidden="true">PF</span>
                              <span className="phw-event-action-pill__label">PDF</span>
                            </button>
                            <button className="btn btn--outline btn--sm phw-event-action-pill" disabled={event.status !== 'completed' || eventEmailingId === event.event_id} onClick={() => void emailEventRecord(event)}>
                              <span className="phw-event-action-pill__icon" aria-hidden="true">EM</span>
                              <span className="phw-event-action-pill__label">{eventEmailingId === event.event_id ? 'Emailing...' : 'Email'}</span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="phw-dashboard__lower-grid phw-stagger phw-stagger-8" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 20 }}>
        <div>
          <div className="phw-section-header">
            <h2 className="phw-section-title">My RSVPs</h2>
          </div>
          <div className="phw-card" style={{ padding: '4px 1rem' }}>
            {loading ? (
              <LoadingSkeleton lines={3} compact />
            ) : myRsvps.length === 0 ? (
              <EmptyState variant="calendar" title="No RSVPs yet" description="RSVP to an event and it will show here." />
            ) : (
              myRsvps.map((row, index) => {
                const style = rsvpStyles[row.response] ?? rsvpStyles.maybe;
                return (
                  <div key={`${row.event_id}-${row.response}-${index}`} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: index < myRsvps.length - 1 ? `1px solid ${colors.slate[100]}` : 'none' }}>
                    <div>
                      <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{row.title}</p>
                      <p style={{ margin: '2px 0 0', fontSize: 11, color: colors.slate[500] }}>{new Date(row.event_date).toLocaleDateString()}</p>
                    </div>
                    <span className="phw-badge" style={{ background: style.bg, color: style.text }}>{style.label}</span>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div>
          <div className="phw-section-header">
            <h2 className="phw-section-title">Take a Vet Fishing</h2>
            <Link to="/tavf" className="phw-section-link">View all &rarr;</Link>
          </div>
          <div className="phw-card" style={{ padding: '4px 1rem' }}>
            {loading ? (
              <LoadingSkeleton lines={3} compact />
            ) : openPostings.length === 0 ? (
              <EmptyState
                variant="fishing"
                title="No open postings"
                description="Post your availability and help a veteran get on the water."
                actionLabel="Post availability"
                onAction={() => navigate('/tavf/new')}
              />
            ) : (
              openPostings.map((posting, index) => (
                <Link key={posting.posting_id} to={`/tavf/${posting.posting_id}`} style={{ display: 'block', textDecoration: 'none', color: 'inherit', padding: '10px 0', borderBottom: index < openPostings.length - 1 ? `1px solid ${colors.slate[100]}` : 'none' }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>Open posting · {posting.location}</p>
                  <p style={{ margin: '2px 0 0', fontSize: 11, color: colors.slate[500] }}>{new Date(posting.event_date).toLocaleDateString()} · Capacity {posting.capacity}</p>
                </Link>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default DashboardPage;