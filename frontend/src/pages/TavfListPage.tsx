import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import tavfApi, { PostingStatus, TavfPosting } from '../api/tavf';
import { useAuth } from '../hooks/useAuth';

const STATUS_LABELS: Record<PostingStatus, string> = {
  open: 'Open',
  filled: 'Filled',
  cancelled: 'Cancelled',
};

function PostingCard({ posting }: { posting: TavfPosting }) {
  const eventDate = new Date(posting.event_date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <div className={`tavf-card tavf-card--${posting.status}`}>
      <div className="tavf-card__header">
        <span className={`tavf-status-badge tavf-status-badge--${posting.status}`}>
          {STATUS_LABELS[posting.status]}
        </span>
        <span className="tavf-card__date">{eventDate}</span>
      </div>

      <div className="tavf-card__body">
        <h3 className="tavf-card__location">{posting.location}</h3>
        {posting.species && (
          <p className="tavf-card__species">Target: {posting.species}</p>
        )}
        {posting.description && (
          <p className="tavf-card__description">{posting.description}</p>
        )}
        <p className="tavf-card__capacity">
          Slots available: <strong>{posting.capacity}</strong>
        </p>
      </div>

      <div className="tavf-card__footer">
        <Link to={`/tavf/${posting.posting_id}`} className="btn btn--primary btn--sm">
          View Details
        </Link>
      </div>
    </div>
  );
}

function TavfListPage() {
  const canCreateTavfPostings = true;
  const { user, canCreateEvents } = useAuth();
  const [postings, setPostings] = useState<TavfPosting[]>([]);
  const [statusFilter, setStatusFilter] = useState<PostingStatus | ''>('open');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subscribed, setSubscribed] = useState(false);
  const [loadingSubscription, setLoadingSubscription] = useState(false);
  const [savingSubscription, setSavingSubscription] = useState(false);
  const [subscriptionError, setSubscriptionError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    tavfApi.listPostings(statusFilter || undefined)
      .then(data => { if (!cancelled) setPostings(data); })
      .catch(err => { if (!cancelled) setError((err as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [statusFilter]);

  useEffect(() => {
    if (!user || canCreateEvents()) {
      return;
    }

    let cancelled = false;
    setLoadingSubscription(true);
    setSubscriptionError(null);

    tavfApi
      .getMySubscription()
      .then((result) => {
        if (!cancelled) {
          setSubscribed(Boolean(result.is_subscribed));
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setSubscriptionError((err as Error).message || 'Unable to load TAVF notification preference.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingSubscription(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [canCreateEvents, user]);

  async function toggleSubscription(next: boolean): Promise<void> {
    setSavingSubscription(true);
    setSubscriptionError(null);
    try {
      const result = await tavfApi.updateMySubscription(next, 'tavf_list_page');
      setSubscribed(Boolean(result.is_subscribed));
    } catch (err) {
      setSubscriptionError((err as Error).message || 'Unable to update TAVF notification preference.');
    } finally {
      setSavingSubscription(false);
    }
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Take a Vet Fishing</h1>
          <p className="page-subtitle">
            Guide members post outings; veterans apply to join.
          </p>
        </div>
        {canCreateTavfPostings && (
          <Link to="/tavf/new" className="btn btn--primary">
            + New Posting
          </Link>
        )}
      </div>

      {user && !canCreateEvents() && (
        <div className="tavf-notify-pref">
          <label className="tavf-notify-pref__toggle">
            <input
              type="checkbox"
              checked={subscribed}
              disabled={loadingSubscription || savingSubscription}
              onChange={(event) => {
                void toggleSubscription(event.target.checked);
              }}
            />
            <span>Notify me when new TAVF opportunities are posted</span>
          </label>
          <p className="tavf-notify-pref__hint">
            {subscribed
              ? 'You are subscribed. We will notify you when guides post new opportunities.'
              : 'Turn this on to receive new TAVF posting alerts by your enabled channels.'}
          </p>
          {subscriptionError && <p className="error-text">{subscriptionError}</p>}
        </div>
      )}

      <div className="tavf-filters">
        <label className="tavf-filters__label">Show:</label>
        {(['', 'open', 'filled', 'cancelled'] as const).map(s => (
          <button
            key={s}
            className={`btn btn--sm ${statusFilter === s ? 'btn--primary' : 'btn--outline'}`}
            onClick={() => setStatusFilter(s)}
          >
            {s === '' ? 'All' : STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {loading && <p className="loading-text">Loading postings…</p>}
      {error && <p className="error-text">{error}</p>}

      {!loading && !error && postings.length === 0 && (
        <div className="empty-state">
          <p>No postings found.</p>
          {canCreateTavfPostings && (
            <Link to="/tavf/new" className="btn btn--primary btn--sm">
              Create the first posting
            </Link>
          )}
        </div>
      )}

      <div className="tavf-grid">
        {postings.map(p => (
          <PostingCard key={p.posting_id} posting={p} />
        ))}
      </div>
    </div>
  );
}

export { TavfListPage };
