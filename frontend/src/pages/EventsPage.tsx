import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { eventsApi, rsvpApi } from '../api/events'
import type { EventRecord, RsvpRecord } from '../api/events'
import { groupsApi } from '../api/groups'
import type { GroupRecord } from '../api/groups'
import { useAuth } from '../hooks/useAuth'

// ── helpers ──────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<string, string> = {
  draft: 'Draft',
  published: 'Published',
  completed: 'Completed',
  cancelled: 'Cancelled',
}

const STATUS_TRANSITIONS: Record<string, EventRecord['status'][]> = {
  draft: ['published', 'cancelled'],
  published: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
}

const ALL_STATUSES: (EventRecord['status'] | 'all')[] = [
  'all', 'draft', 'published', 'completed', 'cancelled',
]

function formatDate(iso: string) {
  return new Date(iso).toLocaleString('en-GB', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`status-badge status-badge--${status}`}>
      {STATUS_LABELS[status] ?? status}
    </span>
  )
}

// ── Slot count display ────────────────────────────────────────────────────────

function SlotCount({ yesCount, capacity }: { yesCount: number; capacity: number | null }) {
  const cap = capacity ?? null
  const pct = cap ? Math.min(100, Math.round((yesCount / cap) * 100)) : null
  const full = cap !== null && yesCount >= cap
  return (
    <span className={`slot-count${full ? ' slot-count--full' : ''}`}>
      {yesCount}/{cap ?? '∞'}
      {pct !== null && ` (${pct}%)`}
    </span>
  )
}

// ── Empty RSVP form payload ───────────────────────────────────────────────────

interface EventFormPayload {
  title: string
  event_date: string
  description: string
  location: string
  end_date: string
  capacity: string
  notification_targets: string[]
}

const EMPTY_FORM: EventFormPayload = {
  title: '', event_date: '', description: '', location: '',
  end_date: '', capacity: '', notification_targets: [],
}

function splitDateTime(value: string): { date: string; time: string } {
  if (!value || !value.includes('T')) {
    return { date: '', time: '' }
  }

  const [date, rawTime] = value.split('T')
  return { date: date ?? '', time: (rawTime ?? '').slice(0, 5) }
}

function joinDateTime(date: string, time: string): string {
  if (!date || !time) {
    return ''
  }
  return `${date}T${time}`
}

function normalizeTimeInput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return ''
  }

  if (trimmed.includes(':')) {
    const [h = '', m = ''] = trimmed.split(':')
    const hours = h.replace(/\D/g, '').slice(0, 2)
    const minutes = m.replace(/\D/g, '').slice(0, 2)
    return minutes ? `${hours}:${minutes}` : `${hours}`
  }

  const digits = trimmed.replace(/\D/g, '').slice(0, 4)
  if (digits.length <= 2) {
    return digits
  }
  if (digits.length === 3) {
    return `${digits.slice(0, 1)}:${digits.slice(1)}`
  }
  return `${digits.slice(0, 2)}:${digits.slice(2)}`
}

function toCanonicalTime(raw: string): string | null {
  const normalized = normalizeTimeInput(raw)
  if (!normalized) {
    return null
  }

  const noColon = normalized.replace(':', '')
  if (!normalized.includes(':')) {
    if (noColon.length === 1 || noColon.length === 2) {
      const hourOnly = Number(noColon)
      if (!Number.isNaN(hourOnly) && hourOnly >= 0 && hourOnly <= 23) {
        return `${String(hourOnly).padStart(2, '0')}:00`
      }
    }
    return null
  }

  const [h, m] = normalized.split(':')
  if (!h || !m) {
    return null
  }

  const hour = Number(h)
  const minute = Number(m)
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    return null
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null
  }

  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

function normalizeDateTimeValue(value: string): string {
  const parts = splitDateTime(value)
  if (!parts.date || !parts.time) {
    return value
  }

  const canonicalTime = toCanonicalTime(parts.time)
  if (!canonicalTime) {
    return value
  }

  return joinDateTime(parts.date, canonicalTime)
}

function isValid24HourDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

function payloadFromRecord(e: EventRecord): EventFormPayload {
  return {
    title: e.title,
    event_date: e.event_date ? e.event_date.slice(0, 16) : '',
    description: e.description ?? '',
    location: e.location ?? '',
    end_date: e.end_date ? e.end_date.slice(0, 16) : '',
    capacity: e.capacity != null ? String(e.capacity) : '',
    notification_targets: [],   // populated separately
  }
}

// ── RSVP summary panel ────────────────────────────────────────────────────────

function RsvpPanel({ eventId, onClose }: { eventId: string; onClose: () => void }) {
  const [rsvps, setRsvps] = useState<RsvpRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    setLoading(true)
    rsvpApi.list(eventId)
      .then(setRsvps)
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false))
  }, [eventId])

  const counts = rsvps.reduce<Record<string, number>>((acc, r) => {
    acc[r.response] = (acc[r.response] ?? 0) + 1
    return acc
  }, {})

  return (
    <div className="rsvp-panel">
      <div className="rsvp-panel__header">
        <h3 className="rsvp-panel__title">RSVP Summary</h3>
        <button className="btn btn--ghost btn--sm" onClick={onClose}>✕</button>
      </div>
      {loading && <p className="rsvp-panel__loading">Loading…</p>}
      {err && <p className="rsvp-panel__error">{err}</p>}
      {!loading && !err && (
        <>
          <div className="rsvp-panel__counts">
            <span className="rsvp-count rsvp-count--yes">✓ Yes: {counts.yes ?? 0}</span>
            <span className="rsvp-count rsvp-count--no">✗ No: {counts.no ?? 0}</span>
            <span className="rsvp-count rsvp-count--maybe">? Maybe: {counts.maybe ?? 0}</span>
            <span className="rsvp-count rsvp-count--waitlist">⏳ Waitlist: {counts.waitlist ?? 0}</span>
          </div>
          {rsvps.length > 0 && (
            <table className="rsvp-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Response</th>
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {rsvps.map(r => (
                  <tr key={r.response_id}>
                    <td>{r.first_name} {r.last_name}</td>
                    <td><StatusBadge status={r.response} /></td>
                    <td className="rsvp-table__notes">{r.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {rsvps.length === 0 && <p className="rsvp-panel__empty">No RSVPs yet.</p>}
        </>
      )}
    </div>
  )
}

// ── Event form modal ──────────────────────────────────────────────────────────

interface EventFormModalProps {
  initial: EventFormPayload
  groups: GroupRecord[]
  onSave: (data: EventFormPayload) => Promise<void>
  onCancel: () => void
  saving: boolean
  error: string | null
  isEdit: boolean
}

function EventFormModal({ initial, groups, onSave, onCancel, saving, error, isEdit }: EventFormModalProps) {
  const [form, setForm] = useState<EventFormPayload>(initial)
  const eventDateParts = splitDateTime(form.event_date)
  const endDateParts = splitDateTime(form.end_date)

  function set(field: keyof EventFormPayload, value: string) {
    setForm(f => ({ ...f, [field]: value }))
  }

  function toggleGroup(id: string) {
    setForm(f => ({
      ...f,
      notification_targets: f.notification_targets.includes(id)
        ? f.notification_targets.filter(g => g !== id)
        : [...f.notification_targets, id],
    }))
  }

  function handleTimeInput(field: 'event_date' | 'end_date', date: string, rawTime: string) {
    const typedTime = normalizeTimeInput(rawTime)
    set(field, joinDateTime(date, typedTime))
  }

  function handleTimeBlur(field: 'event_date' | 'end_date', date: string, rawTime: string) {
    const canonical = toCanonicalTime(rawTime)
    if (!canonical) {
      return
    }
    set(field, joinDateTime(date, canonical))
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modal__header">
          <h2 className="modal__title">{isEdit ? 'Edit Event' : 'New Event'}</h2>
          <button className="btn btn--ghost btn--sm" onClick={onCancel} disabled={saving}>✕</button>
        </div>

        <div className="modal__body">
          <div className="form-grid">
            <div className="form-field form-field--full">
              <label className="form-label">Title *</label>
              <input className="form-input" value={form.title} onChange={e => set('title', e.target.value)} required />
            </div>

            <div className="form-field">
              <label className="form-label">Event Date *</label>
              <input
                className="form-input"
                type="date"
                value={eventDateParts.date}
                onChange={e => set('event_date', joinDateTime(e.target.value, eventDateParts.time || '00:00'))}
                required
              />
            </div>

            <div className="form-field">
              <label className="form-label">Event Time (24-hour) *</label>
              <input
                className="form-input"
                type="text"
                inputMode="numeric"
                placeholder="HH:mm"
                value={eventDateParts.time}
                onChange={e => handleTimeInput('event_date', eventDateParts.date, e.target.value)}
                onBlur={e => handleTimeBlur('event_date', eventDateParts.date, e.target.value)}
                required
              />
            </div>

            <div className="form-field">
              <label className="form-label">End Date</label>
              <input
                className="form-input"
                type="date"
                value={endDateParts.date}
                onChange={e => set('end_date', joinDateTime(e.target.value, endDateParts.time || '00:00'))}
              />
            </div>

            <div className="form-field">
              <label className="form-label">End Time (24-hour)</label>
              <input
                className="form-input"
                type="text"
                inputMode="numeric"
                placeholder="HH:mm"
                value={endDateParts.time}
                onChange={e => handleTimeInput('end_date', endDateParts.date, e.target.value)}
                onBlur={e => handleTimeBlur('end_date', endDateParts.date, e.target.value)}
              />
            </div>

            <div className="form-field form-field--full">
              <label className="form-label">Location</label>
              <input className="form-input" value={form.location} onChange={e => set('location', e.target.value)} />
            </div>

            <div className="form-field">
              <label className="form-label">Capacity (blank = unlimited)</label>
              <input className="form-input" type="number" min="1" value={form.capacity} onChange={e => set('capacity', e.target.value)} />
            </div>

            <div className="form-field form-field--full">
              <label className="form-label">Description</label>
              <textarea className="form-textarea" rows={3} value={form.description} onChange={e => set('description', e.target.value)} />
            </div>

            {groups.length > 0 && (
              <div className="form-field form-field--full">
                <label className="form-label">Target Groups</label>
                <div className="group-checks">
                  {groups.map(g => (
                    <label key={g.group_id} className="group-check">
                      <input
                        type="checkbox"
                        checked={form.notification_targets.includes(g.group_id)}
                        onChange={() => toggleGroup(g.group_id)}
                      />
                      {g.group_name}
                    </label>
                  ))}
                </div>
              </div>
            )}
          </div>

          {error && <p className="form-error">{error}</p>}
        </div>

        <div className="modal__footer">
          <button className="btn btn--outline" onClick={onCancel} disabled={saving}>Cancel</button>
          <button
            className="btn btn--primary"
            onClick={() => onSave(form)}
            disabled={saving || !form.title || !form.event_date}
          >
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Event'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main EventsPage ───────────────────────────────────────────────────────────

function EventsPage() {
  const navigate = useNavigate()
  const { isAdmin, canCreateEvents } = useAuth()
  const canEdit = isAdmin() || canCreateEvents()

  const [events, setEvents] = useState<EventRecord[]>([])
  const [groups, setGroups] = useState<GroupRecord[]>([])
  const [filter, setFilter] = useState<EventRecord['status'] | 'all'>('all')
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  // modals
  const [showForm, setShowForm] = useState(false)
  const [editTarget, setEditTarget] = useState<EventRecord | null>(null)
  const [formSaving, setFormSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // RSVP panel
  const [rsvpEventId, setRsvpEventId] = useState<string | null>(null)

  // status transition in-flight
  const [transitioning, setTransitioning] = useState<string | null>(null)

  const abortRef = useRef<AbortController | null>(null)

  const loadEvents = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    setLoading(true)
    setErr(null)
    try {
      const data = await eventsApi.list(filter === 'all' ? undefined : filter)
      setEvents(data)
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== 'AbortError') setErr(e.message)
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    void loadEvents()
    if (canEdit) {
      groupsApi.list().then(setGroups).catch(() => setGroups([]))
    }
  }, [loadEvents, canEdit])

  async function handleSave(form: EventFormPayload) {
    setFormSaving(true)
    setFormError(null)
    try {
      const normalizedEventDate = normalizeDateTimeValue(form.event_date)
      const normalizedEndDate = form.end_date ? normalizeDateTimeValue(form.end_date) : ''

      if (!isValid24HourDateTime(normalizedEventDate)) {
        setFormError('Event time must be valid 24-hour time. Examples: 2041, 941, or 20:41.')
        return
      }

      if (form.end_date && !isValid24HourDateTime(normalizedEndDate)) {
        setFormError('End time must be valid 24-hour time. Examples: 2041, 941, or 20:41.')
        return
      }

      const payload = {
        title: form.title,
        event_date: normalizedEventDate,
        description: form.description || null,
        location: form.location || null,
        end_date: normalizedEndDate || null,
        capacity: form.capacity ? Number(form.capacity) : null,
        notification_targets: form.notification_targets.map(id => ({ group_id: id })),
      }

      if (editTarget) {
        await eventsApi.update(editTarget.event_id, payload)
      } else {
        await eventsApi.create(payload)
      }

      setShowForm(false)
      setEditTarget(null)
      await loadEvents()
    } catch (e: unknown) {
      setFormError(e instanceof Error ? e.message : 'Save failed.')
    } finally {
      setFormSaving(false)
    }
  }

  async function handleStatusTransition(event: EventRecord, newStatus: EventRecord['status']) {
    setTransitioning(event.event_id)
    try {
      await eventsApi.updateStatus(event.event_id, newStatus)
      await loadEvents()
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : 'Status change failed.')
    } finally {
      setTransitioning(null)
    }
  }

  function openCreate() {
    setEditTarget(null)
    setFormError(null)
    setShowForm(true)
  }

  function openEdit(event: EventRecord) {
    setEditTarget(event)
    setFormError(null)
    setShowForm(true)
  }

  function closeForm() {
    setShowForm(false)
    setEditTarget(null)
    setFormError(null)
  }

  return (
    <div className="events-page">
      <div className="events-page__header">
        <div>
          <h1 className="page-title">Events</h1>
          <p className="page-subtitle">Browse and manage upcoming events.</p>
        </div>
        {canEdit && (
          <button className="btn btn--primary" onClick={openCreate}>+ New Event</button>
        )}
      </div>

      {/* Status filter */}
      <div className="events-filter">
        {ALL_STATUSES.map(s => (
          <button
            key={s}
            className={`events-filter__btn${filter === s ? ' events-filter__btn--active' : ''}`}
            onClick={() => setFilter(s)}
          >
            {s === 'all' ? 'All' : STATUS_LABELS[s]}
          </button>
        ))}
      </div>

      {err && <p className="events-error">{err}</p>}
      {loading && <p className="events-loading">Loading events…</p>}

      {!loading && events.length === 0 && (
        <p className="events-empty">No events found{filter !== 'all' ? ` with status "${filter}"` : ''}.</p>
      )}

      {/* Event list */}
      <div className="events-list">
        {events.map(event => {
          const transitions = STATUS_TRANSITIONS[event.status] ?? []
          const isTransitioning = transitioning === event.event_id
          return (
            <div key={event.event_id} className="event-card">
              <div className="event-card__top">
                <div className="event-card__meta">
                  <StatusBadge status={event.status} />
                  <span className="event-card__date">{formatDate(event.event_date)}</span>
                  {event.location && <span className="event-card__location">📍 {event.location}</span>}
                </div>
                <SlotCount yesCount={event.yes_count ?? 0} capacity={event.capacity} />
              </div>

              <h2 className="event-card__title">{event.title}</h2>
              {event.description && (
                <p className="event-card__desc">{event.description}</p>
              )}

              <div className="event-card__footer">
                <div className="event-card__actions">
                  <button
                    className="btn btn--outline btn--sm"
                    onClick={() => setRsvpEventId(rsvpEventId === event.event_id ? null : event.event_id)}
                  >
                    RSVP List ({event.yes_count ?? 0})
                  </button>

                  {canEdit && (
                    <button className="btn btn--outline btn--sm" onClick={() => openEdit(event)}>
                      Edit
                    </button>
                  )}

                  {isAdmin() && (
                    <button className="btn btn--outline btn--sm" onClick={() => navigate(`/events/${event.event_id}/assign`)}>
                      Assign
                    </button>
                  )}

                  {canEdit && transitions.map(next => (
                    <button
                      key={next}
                      className={`btn btn--sm btn--status-${next}`}
                      disabled={isTransitioning}
                      onClick={() => handleStatusTransition(event, next)}
                    >
                      {isTransitioning ? '…' : STATUS_LABELS[next]}
                    </button>
                  ))}
                </div>

                {event.target_count ? (
                  <span className="event-card__groups">{event.target_count} group{event.target_count !== 1 ? 's' : ''} targeted</span>
                ) : null}
              </div>

              {rsvpEventId === event.event_id && (
                <RsvpPanel eventId={event.event_id} onClose={() => setRsvpEventId(null)} />
              )}
            </div>
          )
        })}
      </div>

      {/* Create / Edit form modal */}
      {showForm && (
        <EventFormModal
          initial={editTarget ? payloadFromRecord(editTarget) : EMPTY_FORM}
          groups={groups}
          onSave={handleSave}
          onCancel={closeForm}
          saving={formSaving}
          error={formError}
          isEdit={editTarget !== null}
        />
      )}
    </div>
  )
}

export { EventsPage }
