import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import { colors, fonts, gradients, rsvpStyles } from '../styles/theme';
import { eventsApi, type EventRecord } from '../api/events';
import { membersApi } from '../api/members';
import tavfApi, { type TavfPosting } from '../api/tavf';
import { useAuth } from '../hooks/useAuth';
import EmptyState from '../components/EmptyState';
import CapacityBadge from '../components/CapacityBadge';

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

function HeroBanner({ userName }: { userName?: string }) {
  return (
    <div
      className="phw-stagger phw-stagger-1"
      style={{
        background: gradients.heroBanner,
        borderRadius: 16,
        padding: '2rem 2rem 1.75rem',
        position: 'relative',
        overflow: 'hidden',
        marginBottom: '1.25rem',
      }}
    >
      <div className="phw-wave-pattern" />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, margin: '0 0 6px', letterSpacing: '2px', textTransform: 'uppercase', fontWeight: 600 }}>
          Colorado Alpine Chapter
        </p>
        <h1 style={{ color: '#fff', fontSize: 24, fontWeight: 600, margin: '0 0 8px' }}>
          Welcome back{userName ? `, ${userName}` : ''}
        </h1>
        <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: 14, margin: 0, fontFamily: fonts.display, fontStyle: 'italic' }}>
          The river is always there, waiting.
        </p>
      </div>
    </div>
  );
}

function DashboardPage() {
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [upcoming, setUpcoming] = useState<EventRecord[]>([]);
  const [myRsvps, setMyRsvps] = useState<DashboardRsvp[]>([]);
  const [openPostings, setOpenPostings] = useState<TavfPosting[]>([]);
  const [stats, setStats] = useState<DashboardStats>({
    totalMembers: 0,
    totalEventsThisYear: 0,
    upcomingEvents: 0,
    totalRsvps: 0,
  });

  const now = useMemo(() => new Date(), []);

  useEffect(() => {
    let active = true;

    async function loadDashboard() {
      try {
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

        if (user?.id) {
          try {
            const responses = await membersApi.rsvps(user.id);
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
        }

        try {
          const postings = await tavfApi.listPostings('open');
          if (active) setOpenPostings(postings.slice(0, 4));
        } catch {
          if (active) setOpenPostings([]);
        }

        if (isAdmin()) {
          try {
            const memberList = await membersApi.list({ page: 1, pageSize: 1, isActive: true });
            if (active) setStats((cur) => ({ ...cur, totalMembers: memberList.total }));
          } catch {
            if (active) setStats((cur) => ({ ...cur, totalMembers: 0 }));
          }
        }
      } finally {
        if (active) setLoading(false);
      }
    }

    void loadDashboard();
    return () => {
      active = false;
    };
  }, [isAdmin, now, user?.id]);

  const displayName = user?.name?.split(' ')[0] ?? undefined;

  return (
    <div style={{ maxWidth: 980, margin: '0 auto' }}>
      <HeroBanner userName={displayName} />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 12, marginBottom: '1.5rem' }}>
        <div className="phw-card phw-stagger phw-stagger-2" style={{ padding: '1rem 1.125rem' }}>
          <p style={{ margin: '0 0 6px', fontSize: 11, color: colors.slate[500], textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 600 }}>Members</p>
          <p style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>{isAdmin() ? stats.totalMembers : '-'}</p>
        </div>
        <div className="phw-card phw-stagger phw-stagger-3" style={{ padding: '1rem 1.125rem' }}>
          <p style={{ margin: '0 0 6px', fontSize: 11, color: colors.slate[500], textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 600 }}>Events YTD</p>
          <p style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>{stats.totalEventsThisYear}</p>
        </div>
        <div className="phw-card phw-stagger phw-stagger-4" style={{ padding: '1rem 1.125rem' }}>
          <p style={{ margin: '0 0 6px', fontSize: 11, color: colors.slate[500], textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 600 }}>Upcoming</p>
          <p style={{ margin: 0, fontSize: 24, fontWeight: 700, color: colors.forest[600] }}>{stats.upcomingEvents}</p>
        </div>
        <div className="phw-card phw-stagger phw-stagger-5" style={{ padding: '1rem 1.125rem' }}>
          <p style={{ margin: '0 0 6px', fontSize: 11, color: colors.slate[500], textTransform: 'uppercase', letterSpacing: '.5px', fontWeight: 600 }}>Yes RSVPs</p>
          <p style={{ margin: 0, fontSize: 24, fontWeight: 700, color: colors.golden[700] }}>{stats.totalRsvps}</p>
        </div>
      </div>

      <div className="phw-stagger phw-stagger-6" style={{ marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>Upcoming events</h2>
          <Link to="/events" style={{ fontSize: 12, color: colors.forest[600], textDecoration: 'none' }}>View all</Link>
        </div>

        {loading ? (
          <div className="phw-card" style={{ padding: '1.25rem' }}>Loading events...</div>
        ) : upcoming.length === 0 ? (
          <div className="phw-card">
            <EmptyState
              variant="river"
              title="No upcoming events yet"
              description="Your next adventure on the water starts here."
              actionLabel={isAdmin() ? 'Create Event' : undefined}
              onAction={isAdmin() ? () => navigate('/events') : undefined}
            />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {upcoming.map((event, index) => {
              const totalSlots = event.capacity ?? 0;
              const filled = event.yes_count ?? 0;
              const stripe = totalSlots > 0 && filled >= totalSlots ? colors.alpine[600] : totalSlots > 0 && totalSlots - filled <= Math.ceil(totalSlots * 0.25) ? colors.golden[600] : colors.forest[600];

              return (
                <Link key={event.event_id} to="/events" style={{ textDecoration: 'none', color: 'inherit' }} className={`phw-stagger phw-stagger-${Math.min(index + 6, 8)}`}>
                  <div className="phw-event-card">
                    <div className="phw-event-card__stripe" style={{ background: stripe }} />
                    <div className="phw-event-card__body">
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, marginBottom: 6 }}>
                        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{event.title}</h3>
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
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      <div className="phw-stagger phw-stagger-7" style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 16 }}>
        <div>
          <h2 style={{ margin: '0 0 10px', fontSize: 16 }}>My RSVPs</h2>
          <div className="phw-card" style={{ padding: '4px 1rem' }}>
            {myRsvps.length === 0 ? (
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
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 }}>
            <h2 style={{ margin: 0, fontSize: 16 }}>Take a Vet Fishing</h2>
            <Link to="/tavf" style={{ fontSize: 12, color: colors.forest[600], textDecoration: 'none' }}>View all</Link>
          </div>
          <div className="phw-card" style={{ padding: '4px 1rem' }}>
            {openPostings.length === 0 ? (
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