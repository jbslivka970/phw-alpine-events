import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import tavfApi, {
  ApplicationStatus,
  PostingStatus,
  TavfApplication,
  TavfMatch,
  TavfPosting,
} from '../api/tavf';
import { useAuth } from '../hooks/useAuth';

const POSTING_STATUS_LABELS: Record<PostingStatus, string> = {
  open: 'Open',
  filled: 'Filled',
  cancelled: 'Cancelled',
};

const APPLICATION_STATUS_LABELS: Record<ApplicationStatus, string> = {
  pending: 'Pending',
  matched: 'Matched',
  waitlisted: 'Waitlisted',
  withdrawn: 'Withdrawn',
};

function ApplicationRow({
  application,
  matches,
  isAdmin,
  postingId,
  onStatusChange,
  onMatch,
  onCancelMatch,
}: {
  application: TavfApplication;
  matches: TavfMatch[];
  isAdmin: boolean;
  postingId: string;
  onStatusChange: (appId: string, status: ApplicationStatus) => Promise<void>;
  onMatch: (postingId: string, appId: string) => Promise<void>;
  onCancelMatch: (matchId: string) => Promise<void>;
}) {
  const existingMatch = matches.find(m => m.application_id === application.application_id);
  const [busy, setBusy] = useState(false);

  async function wrap(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  }

  return (
    <tr className="tavf-app-row">
      <td className="tavf-app-row__id">{application.vet_member_id.slice(0, 8)}…</td>
      <td>
        <span className={`tavf-status-badge tavf-status-badge--${application.status}`}>
          {APPLICATION_STATUS_LABELS[application.status]}
        </span>
      </td>
      <td className="tavf-app-row__notes">{application.notes ?? '—'}</td>
      <td className="tavf-app-row__applied">
        {new Date(application.applied_at).toLocaleDateString()}
      </td>
      {isAdmin && (
        <td className="tavf-app-row__actions">
          {application.status === 'pending' && !existingMatch && (
            <button
              className="btn btn--primary btn--xs"
              disabled={busy}
              onClick={() => wrap(() => onMatch(postingId, application.application_id))}
            >
              Confirm match
            </button>
          )}
          {existingMatch && existingMatch.status === 'confirmed' && (
            <button
              className="btn btn--danger btn--xs"
              disabled={busy}
              onClick={() => wrap(() => onCancelMatch(existingMatch.match_id))}
            >
              Cancel match
            </button>
          )}
          {application.status === 'pending' && (
            <button
              className="btn btn--outline btn--xs"
              disabled={busy}
              onClick={() => wrap(() => onStatusChange(application.application_id, 'waitlisted'))}
            >
              Waitlist
            </button>
          )}
          {(application.status === 'pending' || application.status === 'waitlisted') && (
            <button
              className="btn btn--outline btn--xs"
              disabled={busy}
              onClick={() => wrap(() => onStatusChange(application.application_id, 'withdrawn'))}
            >
              Withdraw
            </button>
          )}
        </td>
      )}
    </tr>
  );
}

function TavfDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isAdmin, canCreateEvents, user } = useAuth();

  const [posting, setPosting] = useState<TavfPosting | null>(null);
  const [applications, setApplications] = useState<TavfApplication[]>([]);
  const [matches, setMatches] = useState<TavfMatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Apply form state
  const [applyNotes, setApplyNotes] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [p, apps, allMatches] = await Promise.all([
        tavfApi.getPosting(id),
        tavfApi.listApplications(id),
        isAdmin() ? tavfApi.listMatches() : Promise.resolve([]),
      ]);
      setPosting(p);
      setApplications(apps);
      setMatches(allMatches.filter(m => m.posting_id === id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id, isAdmin]);

  useEffect(() => { void load(); }, [load]);

  async function handleApply(e: React.FormEvent) {
    e.preventDefault();
    if (!id || !user?.id) return;
    setApplying(true);
    setApplyError(null);
    try {
      await tavfApi.applyToPosting(id, {
        vet_member_id: user.id,
        notes: applyNotes || undefined,
      });
      setApplyNotes('');
      await load();
    } catch (err) {
      setApplyError((err as Error).message);
    } finally {
      setApplying(false);
    }
  }

  async function handleStatusChange(appId: string, status: ApplicationStatus) {
    await tavfApi.updateApplicationStatus(appId, status);
    await load();
  }

  async function handleMatch(postingId: string, appId: string) {
    await tavfApi.createMatch({ posting_id: postingId, application_id: appId, matched_by: user?.id });
    await load();
  }

  async function handleCancelMatch(matchId: string) {
    await tavfApi.deleteMatch(matchId);
    await load();
  }

  async function handleDeletePosting() {
    if (!id || !confirm('Delete this posting? This cannot be undone.')) return;
    await tavfApi.deletePosting(id);
    navigate('/tavf');
  }

  async function handlePostingStatusChange(status: PostingStatus) {
    if (!id) return;
    await tavfApi.updatePosting(id, { status });
    await load();
  }

  if (loading) return <div className="page-container"><p className="loading-text">Loading…</p></div>;
  if (error)   return <div className="page-container"><p className="error-text">{error}</p></div>;
  if (!posting) return <div className="page-container"><p className="error-text">Posting not found.</p></div>;

  const eventDate = new Date(posting.event_date).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  const alreadyApplied = applications.some(a => a.vet_member_id === user?.id);
  const canApply = posting.status === 'open' && !alreadyApplied && !canCreateEvents();

  return (
    <div className="page-container">
      <div className="page-header">
        <div>
          <Link to="/tavf" className="breadcrumb-link">← Back to Postings</Link>
          <h1 className="page-title">{posting.location}</h1>
          <p className="page-subtitle">{eventDate}</p>
        </div>
        {canCreateEvents() && (
          <div className="page-header__actions">
            {posting.status === 'open' && (
              <button
                className="btn btn--outline btn--sm"
                onClick={() => handlePostingStatusChange('filled')}
              >
                Mark Filled
              </button>
            )}
            {posting.status !== 'cancelled' && (
              <button
                className="btn btn--outline btn--sm"
                onClick={() => handlePostingStatusChange('cancelled')}
              >
                Cancel Posting
              </button>
            )}
            <button className="btn btn--danger btn--sm" onClick={handleDeletePosting}>
              Delete
            </button>
          </div>
        )}
      </div>

      <div className="tavf-detail-meta">
        <span className={`tavf-status-badge tavf-status-badge--${posting.status}`}>
          {POSTING_STATUS_LABELS[posting.status]}
        </span>
        <span className="tavf-detail-meta__item">
          <strong>Capacity:</strong> {posting.capacity} veteran{posting.capacity !== 1 ? 's' : ''}
        </span>
        {posting.species && (
          <span className="tavf-detail-meta__item">
            <strong>Target:</strong> {posting.species}
          </span>
        )}
      </div>

      {posting.description && (
        <p className="tavf-detail-description">{posting.description}</p>
      )}

      {/* Apply section */}
      {canApply && (
        <section className="tavf-apply-section">
          <h2 className="section-title">Apply to Join</h2>
          <form onSubmit={handleApply} className="tavf-apply-form">
            {applyError && <p className="error-text">{applyError}</p>}
            <div className="form-group">
              <label className="form-label" htmlFor="apply-notes">Notes (optional)</label>
              <textarea
                id="apply-notes"
                className="form-textarea"
                rows={3}
                value={applyNotes}
                onChange={e => setApplyNotes(e.target.value)}
                placeholder="Any relevant experience or questions for the guide…"
                maxLength={1000}
              />
            </div>
            <button type="submit" className="btn btn--primary" disabled={applying}>
              {applying ? 'Submitting…' : 'Submit Application'}
            </button>
          </form>
        </section>
      )}

      {alreadyApplied && !canCreateEvents() && (
        <div className="tavf-applied-notice">
          You have already applied to this posting.
        </div>
      )}

      {/* Applications table (admin/event creators) */}
      {canCreateEvents() && (
        <section className="tavf-applications-section">
          <h2 className="section-title">
            Applications <span className="section-count">({applications.length})</span>
          </h2>

          {applications.length === 0 ? (
            <p className="empty-text">No applications yet.</p>
          ) : (
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Veteran ID</th>
                    <th>Status</th>
                    <th>Notes</th>
                    <th>Applied</th>
                    {isAdmin() && <th>Actions</th>}
                  </tr>
                </thead>
                <tbody>
                  {applications.map(app => (
                    <ApplicationRow
                      key={app.application_id}
                      application={app}
                      matches={matches}
                      isAdmin={isAdmin()}
                      postingId={posting.posting_id}
                      onStatusChange={handleStatusChange}
                      onMatch={handleMatch}
                      onCancelMatch={handleCancelMatch}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export { TavfDetailPage };
