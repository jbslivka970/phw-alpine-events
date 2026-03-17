import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import tavfApi from '../api/tavf';
import { useAuth } from '../hooks/useAuth';

function TavfNewPage() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [eventDate, setEventDate] = useState('');
  const [location, setLocation] = useState('');
  const [capacity, setCapacity] = useState<number>(1);
  const [species, setSpecies] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!user?.id) {
      setError('You must be logged in to create a posting.');
      return;
    }

    setSubmitting(true);
    setError(null);

    try {
      const posting = await tavfApi.createPosting({
        guide_member_id: user.id,
        event_date: eventDate,
        location,
        capacity,
        species: species || undefined,
        description: description || undefined,
      });
      navigate(`/tavf/${posting.posting_id}`);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="page-container page-container--narrow">
      <div className="page-header">
        <h1 className="page-title">New TAVF Posting</h1>
      </div>

      <form className="form-card" onSubmit={handleSubmit}>
        {error && <p className="error-text">{error}</p>}

        <div className="form-group">
          <label className="form-label" htmlFor="event-date">Date <span className="form-required">*</span></label>
          <input
            id="event-date"
            type="date"
            className="form-input"
            value={eventDate}
            onChange={e => setEventDate(e.target.value)}
            required
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="location">Location <span className="form-required">*</span></label>
          <input
            id="location"
            type="text"
            className="form-input"
            placeholder="e.g. South Platte River, Deckers CO"
            value={location}
            onChange={e => setLocation(e.target.value)}
            required
            maxLength={500}
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="capacity">Veteran slots <span className="form-required">*</span></label>
          <input
            id="capacity"
            type="number"
            className="form-input form-input--narrow"
            min={1}
            max={20}
            value={capacity}
            onChange={e => setCapacity(parseInt(e.target.value, 10))}
            required
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="species">Target species</label>
          <input
            id="species"
            type="text"
            className="form-input"
            placeholder="e.g. Brown Trout, Rainbow Trout"
            value={species}
            onChange={e => setSpecies(e.target.value)}
            maxLength={200}
          />
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="description">Description</label>
          <textarea
            id="description"
            className="form-textarea"
            rows={4}
            placeholder="Details about the outing, gear needed, skill level, etc."
            value={description}
            onChange={e => setDescription(e.target.value)}
            maxLength={2000}
          />
        </div>

        <div className="form-actions">
          <button
            type="button"
            className="btn btn--outline"
            onClick={() => navigate('/tavf')}
            disabled={submitting}
          >
            Cancel
          </button>
          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create Posting'}
          </button>
        </div>
      </form>
    </div>
  );
}

export { TavfNewPage };
