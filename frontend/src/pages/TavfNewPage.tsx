import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import tavfApi from '../api/tavf';
import { useAuth } from '../hooks/useAuth';

type CommonLocation = {
  query: string;
  label: string;
  lat?: string;
  lon?: string;
  count: number;
  lastUsedAt: string;
};

const COMMON_LOCATIONS_KEY = 'phw-common-locations';

function loadCommonLocations(): CommonLocation[] {
  try {
    const raw = window.localStorage.getItem(COMMON_LOCATIONS_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as CommonLocation[];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((row) => typeof row?.query === 'string' && row.query.trim().length > 0);
  } catch {
    return [];
  }
}

function saveCommonLocations(rows: CommonLocation[]): void {
  try {
    window.localStorage.setItem(COMMON_LOCATIONS_KEY, JSON.stringify(rows.slice(0, 20)));
  } catch {
    // Ignore storage failures in privacy-restricted browsers.
  }
}

function TavfNewPage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const capacity = 1;

  const [eventDate, setEventDate] = useState('');
  const [location, setLocation] = useState('');
  const [species, setSpecies] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commonLocations, setCommonLocations] = useState<CommonLocation[]>(() => loadCommonLocations());
  const [validatingLocation, setValidatingLocation] = useState(false);
  const [locationValidation, setLocationValidation] = useState<string | null>(null);
  const [locationValidationError, setLocationValidationError] = useState<string | null>(null);

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

  async function validateLocation(): Promise<void> {
    const query = location.trim();
    if (!query) {
      setLocationValidation(null);
      setLocationValidationError('Enter a location before validating.');
      return;
    }

    setValidatingLocation(true);
    setLocationValidation(null);
    setLocationValidationError(null);

    try {
      const params = new URLSearchParams({
        format: 'json',
        q: query,
        limit: '1',
      });
      const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`Validation request failed (${response.status})`);
      }
      const payload = (await response.json()) as Array<{ display_name?: string; lat?: string; lon?: string }>;
      const first = payload[0];
      if (!first?.display_name) {
        setLocationValidationError('No geocoding match found. Try a more specific address.');
        return;
      }
      setLocationValidation(`Validated: ${first.display_name}${first.lat && first.lon ? ` (lat ${first.lat}, lon ${first.lon})` : ''}`);
    } catch (err) {
      setLocationValidationError(err instanceof Error ? err.message : 'Unable to validate location right now.');
    } finally {
      setValidatingLocation(false);
    }
  }

  function saveCurrentAsCommonLocation(): void {
    const query = location.trim();
    if (!query) {
      setLocationValidationError('Enter a location before saving it as common.');
      return;
    }

    const next = [...commonLocations];
    const existingIndex = next.findIndex((row) => row.query.toLowerCase() === query.toLowerCase());
    if (existingIndex >= 0) {
      next[existingIndex] = {
        ...next[existingIndex],
        count: (next[existingIndex]?.count ?? 0) + 1,
        lastUsedAt: new Date().toISOString(),
        label: query,
      };
    } else {
      next.push({
        query,
        label: query,
        count: 1,
        lastUsedAt: new Date().toISOString(),
      });
    }

    next.sort((a, b) => (b.count - a.count) || (b.lastUsedAt.localeCompare(a.lastUsedAt)));
    saveCommonLocations(next);
    setCommonLocations(next);
    setLocationValidation('Saved to common locations.');
    setLocationValidationError(null);
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
          {commonLocations.length > 0 && (
            <>
              <label className="form-label" htmlFor="tavf-common-location">Use common location</label>
              <select
                id="tavf-common-location"
                className="form-input"
                value=""
                onChange={(event) => {
                  if (event.target.value) {
                    setLocation(event.target.value);
                  }
                }}
              >
                <option value="">Select a saved location</option>
                {commonLocations.slice(0, 10).map((row) => (
                  <option key={row.query} value={row.query}>{row.label}</option>
                ))}
              </select>
            </>
          )}
          <div className="location-tools">
            <button type="button" className="btn btn--outline btn--sm" onClick={() => void validateLocation()} disabled={validatingLocation || submitting}>
              {validatingLocation ? 'Validating…' : 'Validate Address'}
            </button>
            <button type="button" className="btn btn--outline btn--sm" onClick={saveCurrentAsCommonLocation} disabled={submitting}>
              Save as Common
            </button>
            {location.trim() && (
              <a
                className="btn btn--outline btn--sm"
                href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(location.trim())}`}
                target="_blank"
                rel="noreferrer"
              >
                Open in Maps
              </a>
            )}
          </div>
          {locationValidation && <p className="success-text">{locationValidation}</p>}
          {locationValidationError && <p className="error-text">{locationValidationError}</p>}
        </div>

        <div className="form-group">
          <label className="form-label">Veteran slots</label>
          <p className="form-help-text">1 slot per posting (guide and one veteran, 1:1).</p>
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
