import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { eventsApi, rsvpApi } from '../api/events'
import type { EventAiDescriptionResponse, EventAiDraftResponse, EventRecord, RsvpRecord } from '../api/events'
import { groupsApi } from '../api/groups'
import type { GroupRecord } from '../api/groups'
import { useAuth } from '../hooks/useAuth'
import { membersApi } from '../api/members'
import type { MemberRecord } from '../api/members'
import LoadingSkeleton from '../components/LoadingSkeleton'
import { toUserErrorMessage } from '../utils/errorMessage'

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

function suggestedIcsFilename(event: EventRecord): string {
  const safeTitle = event.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return `${safeTitle || 'event'}-${event.event_id}.ics`
}

function parseDispositionFilename(headerValue: string | null): string | null {
  if (!headerValue) {
    return null
  }

  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(headerValue)
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1])
  }

  const plainMatch = /filename="?([^";]+)"?/i.exec(headerValue)
  return plainMatch?.[1] ?? null
}

function parseRecipientInput(raw: string): string[] {
  return raw
    .split(/[;,\s]+/)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0)
}

function isValidEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function downloadBlobFile(blob: Blob, headers: Headers, fallbackFilename: string) {
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  const fromHeader = parseDispositionFilename(headers.get('content-disposition'))
  anchor.href = objectUrl
  anchor.download = fromHeader ?? fallbackFilename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(objectUrl)
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

function SlotCount({
  yesCount,
  capacity,
  mentorCapacity,
  participantCapacity,
}: {
  yesCount: number;
  capacity: number | null;
  mentorCapacity: number | null;
  participantCapacity: number | null;
}) {
  const cap = capacity ?? null
  const pct = cap ? Math.min(100, Math.round((yesCount / cap) * 100)) : null
  const full = cap !== null && yesCount >= cap
  return (
    <span className={`slot-count${full ? ' slot-count--full' : ''}`}>
      {yesCount}/{cap ?? '∞'}
      {pct !== null && ` (${pct}%)`}
      {(mentorCapacity !== null || participantCapacity !== null)
        ? ` V:${mentorCapacity ?? '∞'} P:${participantCapacity ?? '∞'}`
        : ''}
    </span>
  )
}

// ── Empty RSVP form payload ───────────────────────────────────────────────────

interface EventFormPayload {
  title: string
  event_date: string
  description: string
  location: string
  photo_url: string
  invitation_stage: 'volunteer' | 'participant' | 'both'
  event_lead_member_id: string
  event_lead_secondary_roles: Array<'MENTOR' | 'PARTICIPANT'>
  scheduler_email: string
  end_date: string
  mentor_capacity: string
  participant_capacity: string
  notification_targets: string[]
  update_reason: string
}

type RsvpDraft = {
  response: 'yes' | 'maybe' | 'no'
  role: 'MENTOR' | 'PARTICIPANT'
}

type LeadDirectoryMember = {
  member_id: string
  first_name: string
  last_name: string
  email: string
}

const DEFAULT_RSVP_DRAFT: RsvpDraft = {
  response: 'yes',
  role: 'PARTICIPANT',
}

type CommonLocation = {
  query: string
  label: string
  county?: string
  state?: string
  count: number
  lastUsedAt: string
}

const PROGRAM_GEO_CONFIG = {
  state: 'Colorado',
  country: 'USA',
  primaryCounties: ['summit', 'eagle', 'routt', 'grand', 'park', 'garfield', 'lake'],
  viewbox: '-109.06,36.99,-102.04,41.0',
}

const COMMON_LOCATIONS_KEY = 'phw-common-locations'

function loadCommonLocations(): CommonLocation[] {
  try {
    const raw = window.localStorage.getItem(COMMON_LOCATIONS_KEY)
    if (!raw) {
      return []
    }
    const parsed = JSON.parse(raw) as CommonLocation[]
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter((row) => typeof row?.query === 'string' && row.query.trim().length > 0)
  } catch {
    return []
  }
}

function saveCommonLocations(rows: CommonLocation[]): void {
  try {
    window.localStorage.setItem(COMMON_LOCATIONS_KEY, JSON.stringify(rows.slice(0, 20)))
  } catch {
    // Ignore storage failures in restricted/private browser contexts.
  }
}

function hasExplicitRegionQualifier(query: string): boolean {
  return /\b(colorado|co|usa|wy|ut|nm|az|ks|ne|tx|id|mt|ca|wa|or|fl|ny|il|pa|va|nc|sc|ga|al|ak|hi|ma|ct|ri|nj|md|dc)\b/i.test(query)
    || /,\s*[A-Z]{2}\b/.test(query)
}

function normalizeGeoVariant(query: string): string {
  return query
    .replace(/\bcamp\s+ground\b/gi, 'campground')
    .replace(/\bfs\s+rd\b/gi, 'forest road')
    .replace(/\bfr\s+(\d+)/gi, 'forest road $1')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildGeoSearchCandidates(query: string): string[] {
  const base = query.trim()
  const normalized = normalizeGeoVariant(base)
  const withRegion = hasExplicitRegionQualifier(normalized)
    ? normalized
    : `${normalized}, ${PROGRAM_GEO_CONFIG.state}, ${PROGRAM_GEO_CONFIG.country}`

  return [...new Set([withRegion, normalized, base])].filter((value) => value.length > 0)
}

function scoreGeoCandidate(
  query: string,
  candidate: { display_name?: string; address?: { county?: string; state?: string; country_code?: string } }
): number {
  const display = (candidate.display_name ?? '').toLowerCase()
  const queryTokens = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const displayTokens = new Set(display.split(/[^a-z0-9]+/).filter(Boolean))
  const tokenHits = queryTokens.filter((token) => displayTokens.has(token)).length

  const county = candidate.address?.county?.replace(/\s+county$/i, '').trim().toLowerCase() ?? ''
  const state = candidate.address?.state?.trim().toLowerCase() ?? ''
  const countryCode = (candidate.address?.country_code ?? '').toLowerCase()
  const inColorado = state === 'colorado' || (countryCode === 'us' && /\bco\b/i.test(state))
  const inPrimaryCounty = county.length > 0 && PROGRAM_GEO_CONFIG.primaryCounties.includes(county)

  return tokenHits * 3 + (inColorado ? 10 : 0) + (inPrimaryCounty ? 4 : 0)
}

function toLocalDateTimeInputValue(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  const hours = String(value.getHours()).padStart(2, '0')
  const minutes = String(value.getMinutes()).padStart(2, '0')
  return `${year}-${month}-${day}T${hours}:${minutes}`
}

function toApiUtcDateTime(localDateTimeValue: string): string {
  const normalized = normalizeDateTimeValue(localDateTimeValue)
  if (!isValid24HourDateTime(normalized)) {
    return localDateTimeValue
  }

  const asLocal = new Date(`${normalized}:00`)
  if (Number.isNaN(asLocal.getTime())) {
    return localDateTimeValue
  }

  return asLocal.toISOString()
}

function toLocalDateTimeFromApi(value: string): string {
  const parsed = new Date(value)
  if (!Number.isNaN(parsed.getTime())) {
    return toLocalDateTimeInputValue(parsed)
  }

  const normalized = normalizeDateTimeValue(value)
  return isValid24HourDateTime(normalized) ? normalized : ''
}

function buildDefaultEventForm(): EventFormPayload {
  const now = new Date()
  now.setSeconds(0, 0)
  const roundedMinutes = Math.ceil(now.getMinutes() / 15) * 15
  now.setMinutes(roundedMinutes)
  const start = new Date(now.getTime() + 60 * 60 * 1000)
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000)

  return {
    title: '',
    event_date: toLocalDateTimeInputValue(start),
    description: '',
    location: '',
    photo_url: '',
    invitation_stage: 'both',
    event_lead_member_id: '',
    event_lead_secondary_roles: [],
    scheduler_email: '',
    end_date: toLocalDateTimeInputValue(end),
    mentor_capacity: '',
    participant_capacity: '',
    notification_targets: [],
    update_reason: '',
  }
}

function splitDateTime(value: string): { date: string; time: string } {
  if (!value || !value.includes('T')) {
    return { date: '', time: '' }
  }

  const [date, rawTime] = value.split('T')
  return { date: date ?? '', time: (rawTime ?? '').slice(0, 5) }
}

function joinDateTime(date: string, time: string): string {
  const cleanDate = date.trim()
  const cleanTime = time.trim()
  if (!cleanDate && !cleanTime) {
    return ''
  }
  return `${cleanDate}T${cleanTime}`
}

function sanitizeTimeInput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return ''
  }

  if (trimmed.includes(':')) {
    const [h = '', m = ''] = trimmed.split(':')
    const hours = h.replace(/\D/g, '').slice(0, 2)
    const minutes = m.replace(/\D/g, '').slice(0, 2)
    if (!hours && !minutes) {
      return ''
    }
    return `${hours}:${minutes}`
  }

  return trimmed.replace(/\D/g, '').slice(0, 4)
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1900 || year > 2100) {
    return false
  }
  if (month < 1 || month > 12) {
    return false
  }
  if (day < 1 || day > 31) {
    return false
  }

  const candidate = new Date(Date.UTC(year, month - 1, day))
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day
}

function normalizeDateInput(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) {
    return ''
  }

  if (trimmed.includes('-') || trimmed.includes('/')) {
    return trimmed.replace(/\//g, '-')
  }

  return trimmed.replace(/[^\d-]/g, '').slice(0, 10)
}

function toCanonicalDate(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }

  const isoMatch = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (isoMatch) {
    const year = Number(isoMatch[1])
    const month = Number(isoMatch[2])
    const day = Number(isoMatch[3])
    if (!isValidCalendarDate(year, month, day)) {
      return null
    }
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  const usMatch = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/)
  if (usMatch) {
    const month = Number(usMatch[1])
    const day = Number(usMatch[2])
    const year = Number(usMatch[3])
    if (!isValidCalendarDate(year, month, day)) {
      return null
    }
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  const digits = trimmed.replace(/\D/g, '')
  if (digits.length === 8) {
    const startsWithYear = digits.startsWith('19') || digits.startsWith('20')
    const year = startsWithYear ? Number(digits.slice(0, 4)) : Number(digits.slice(4))
    const month = startsWithYear ? Number(digits.slice(4, 6)) : Number(digits.slice(0, 2))
    const day = startsWithYear ? Number(digits.slice(6, 8)) : Number(digits.slice(2, 4))
    if (!isValidCalendarDate(year, month, day)) {
      return null
    }
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  return null
}

function toCanonicalTime(raw: string): string | null {
  const normalized = sanitizeTimeInput(raw)
  if (!normalized || normalized === ':') {
    return null
  }

  if (!normalized.includes(':')) {
    if (normalized.length === 1 || normalized.length === 2) {
      const hourOnly = Number(normalized)
      if (!Number.isNaN(hourOnly) && hourOnly >= 0 && hourOnly <= 23) {
        return `${String(hourOnly).padStart(2, '0')}:00`
      }
      return null
    }

    if (normalized.length === 3) {
      const hour = Number(normalized.slice(0, 1))
      const minute = Number(normalized.slice(1))
      if (!Number.isNaN(hour) && !Number.isNaN(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      }
      return null
    }

    if (normalized.length === 4) {
      const hour = Number(normalized.slice(0, 2))
      const minute = Number(normalized.slice(2))
      if (!Number.isNaN(hour) && !Number.isNaN(minute) && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
        return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      }
      return null
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

  const canonicalDate = toCanonicalDate(parts.date)
  if (!canonicalDate) {
    return value
  }

  const canonicalTime = toCanonicalTime(parts.time)
  if (!canonicalTime) {
    return value
  }

  return joinDateTime(canonicalDate, canonicalTime)
}

function isValid24HourDateTime(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

function payloadFromRecord(e: EventRecord): EventFormPayload {
  return {
    title: e.title,
    event_date: e.event_date ? toLocalDateTimeFromApi(e.event_date) : '',
    description: e.description ?? '',
    location: e.location ?? '',
    photo_url: e.photo_url ?? '',
    invitation_stage: e.invitation_stage ?? 'both',
    event_lead_member_id: e.event_lead_member_id ?? '',
    event_lead_secondary_roles: e.event_lead_secondary_roles ?? [],
    scheduler_email: e.scheduler_email ?? '',
    end_date: e.end_date ? toLocalDateTimeFromApi(e.end_date) : '',
    mentor_capacity: e.mentor_capacity != null ? String(e.mentor_capacity) : '',
    participant_capacity: e.participant_capacity != null
      ? String(e.participant_capacity)
      : (e.capacity != null ? String(e.capacity) : ''),
    notification_targets: [],   // populated separately
    update_reason: '',
  }
}

function parseCapacityValue(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) {
    return null
  }
  if (!/^\d+$/.test(trimmed)) {
    return null
  }
  const numeric = Number(trimmed)
  if (!Number.isInteger(numeric) || numeric < 1) {
    return null
  }
  return numeric
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
      .catch((e: unknown) => setErr(toUserErrorMessage(e, 'Unable to load RSVP details.')))
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
      {loading && <LoadingSkeleton lines={3} compact />}
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
  leadMembers: LeadDirectoryMember[]
  onSave: (data: EventFormPayload) => Promise<void>
  onGenerateAiDescriptionPreview: (
    payload: { title: string; description: string; event_date?: string; location?: string | null; event_lead_name?: string | null },
    tone: 'friendly' | 'professional' | 'casual' | 'exciting'
  ) => Promise<EventAiDescriptionResponse>
  onGenerateAiDraftPreview: (
    payload: { title: string; event_date: string; location?: string | null; description?: string | null; event_lead_name?: string | null },
    tone: 'friendly' | 'professional' | 'casual' | 'exciting'
  ) => Promise<EventAiDraftResponse>
  onCancel: () => void
  saving: boolean
  error: string | null
  isEdit: boolean
}

interface FormFieldErrors {
  title?: string
  event_lead_member_id?: string
  event_date?: string
  event_time?: string
  end_date?: string
  end_time?: string
  scheduler_email?: string
  mentor_capacity?: string
  participant_capacity?: string
}

function EventFormModal({ initial, groups, leadMembers, onSave, onGenerateAiDescriptionPreview, onGenerateAiDraftPreview, onCancel, saving, error, isEdit }: EventFormModalProps) {
  const [form, setForm] = useState<EventFormPayload>(initial)
  const [endDateManuallyEdited, setEndDateManuallyEdited] = useState<boolean>(isEdit)
  const [fieldErrors, setFieldErrors] = useState<FormFieldErrors>({})
  const [aiTone, setAiTone] = useState<'friendly' | 'professional' | 'casual' | 'exciting'>('friendly')
  const [aiDescriptionLoading, setAiDescriptionLoading] = useState(false)
  const [aiDescriptionError, setAiDescriptionError] = useState<string | null>(null)
  const [aiDescriptionProvider, setAiDescriptionProvider] = useState<EventAiDescriptionResponse['provider'] | null>(null)
  const [aiDescriptionDraft, setAiDescriptionDraft] = useState('')
  const [aiDraftLoading, setAiDraftLoading] = useState(false)
  const [aiDraftError, setAiDraftError] = useState<string | null>(null)
  const [aiDraftResult, setAiDraftResult] = useState<EventAiDraftResponse | null>(null)
  const [aiSubjectDraft, setAiSubjectDraft] = useState('')
  const [aiEmailDraft, setAiEmailDraft] = useState('')
  const [aiSmsDraft, setAiSmsDraft] = useState('')
  const [commonLocations, setCommonLocations] = useState<CommonLocation[]>(() => loadCommonLocations())
  const [locationValidation, setLocationValidation] = useState<string | null>(null)
  const [locationValidationError, setLocationValidationError] = useState<string | null>(null)
  const [lastValidatedGeo, setLastValidatedGeo] = useState<{ query: string; county: string; state: string } | null>(null)
  const [validatingLocation, setValidatingLocation] = useState(false)
  const eventDateParts = splitDateTime(form.event_date)
  const endDateParts = splitDateTime(form.end_date)
  const selectedLeadMember = leadMembers.find((member) => member.member_id === form.event_lead_member_id) ?? null
  const aiLeadName = selectedLeadMember
    ? `${selectedLeadMember.first_name} ${selectedLeadMember.last_name}`.trim()
    : null

  function set(field: keyof EventFormPayload, value: string) {
    setForm(f => ({ ...f, [field]: value }))
    setFieldErrors(prev => ({ ...prev, [field]: undefined }))
  }

  function toggleLeadSecondaryRole(role: 'MENTOR' | 'PARTICIPANT') {
    setForm((current) => {
      const hasRole = current.event_lead_secondary_roles.includes(role)
      return {
        ...current,
        event_lead_secondary_roles: hasRole
          ? current.event_lead_secondary_roles.filter((existing) => existing !== role)
          : [...current.event_lead_secondary_roles, role],
      }
    })
  }

  function setDateTimeField(field: 'event_date' | 'end_date', date: string, time: string) {
    const nextValue = joinDateTime(date, time)
    if (field === 'end_date') {
      setEndDateManuallyEdited(true)
      set('end_date', nextValue)
      return
    }

    setForm((current) => {
      const next: EventFormPayload = { ...current, event_date: nextValue }
      if (!endDateManuallyEdited) {
        const currentEnd = splitDateTime(current.end_date)
        const syncedEndTime = currentEnd.time || time
        next.end_date = joinDateTime(date, syncedEndTime)
      }
      return next
    })
    setFieldErrors(prev => ({ ...prev, event_date: undefined, event_time: undefined, end_date: undefined }))
  }

  async function validateLocation(): Promise<void> {
    const query = form.location.trim()
    if (!query) {
      setLocationValidation(null)
      setLocationValidationError('Enter a location before validating.')
      return
    }

    setValidatingLocation(true)
    setLocationValidation(null)
    setLocationValidationError(null)

    try {
      const searchQueries = buildGeoSearchCandidates(query)
      const aggregated: Array<{
        display_name?: string
        lat?: string
        lon?: string
        address?: { county?: string; state?: string; country_code?: string }
      }> = []

      for (const searchQuery of searchQueries) {
        const params = new URLSearchParams({
          format: 'jsonv2',
          q: searchQuery,
          limit: '5',
          addressdetails: '1',
          viewbox: PROGRAM_GEO_CONFIG.viewbox,
          bounded: '0',
          countrycodes: 'us',
        })
        const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`)
        if (!response.ok) {
          throw new Error(`Validation request failed (${response.status})`)
        }
        const payload = (await response.json()) as Array<{
          display_name?: string
          lat?: string
          lon?: string
          address?: { county?: string; state?: string; country_code?: string }
        }>
        aggregated.push(...payload)
      }

      const deduped = Array.from(
        new Map(
          aggregated
            .filter((row) => typeof row.display_name === 'string' && row.display_name.trim().length > 0)
            .map((row) => [row.display_name!.toLowerCase(), row])
        ).values()
      )

      const ranked = deduped.sort((a, b) => scoreGeoCandidate(query, b) - scoreGeoCandidate(query, a))
      const first = ranked[0]
      if (!first?.display_name) {
        setLocationValidationError('No geocoding match found. Try a more specific address.')
        return
      }
      const county = first.address?.county?.replace(/\s+county$/i, '').trim() ?? ''
      const state = first.address?.state?.trim() ?? ''
      const countryCode = (first.address?.country_code ?? '').toLowerCase()
      const inColorado = state.toLowerCase() === 'colorado' || countryCode === 'us' && /\bco\b/i.test(state)
      const inPrimaryCounty = county && PROGRAM_GEO_CONFIG.primaryCounties.includes(county.toLowerCase())

      if (!inColorado) {
        setLocationValidation(`Validated (outside Colorado): ${first.display_name}${first.lat && first.lon ? ` (lat ${first.lat}, lon ${first.lon})` : ''}`)
        setLocationValidationError('This location appears to be outside Colorado. Confirm this is intentional.')
      } else if (inPrimaryCounty) {
        setLocationValidation(`Validated (primary county: ${county} County, ${state}): ${first.display_name}`)
        setLocationValidationError(null)
      } else {
        setLocationValidation(`Validated (Colorado, outside primary counties): ${first.display_name}`)
        setLocationValidationError('Location is in Colorado but outside preferred counties (Summit, Eagle, Routt, Grand, Park, Garfield, Lake).')
      }

      setLastValidatedGeo({
        query,
        county,
        state,
      })
    } catch (err) {
      setLocationValidationError(err instanceof Error ? err.message : 'Unable to validate location right now.')
    } finally {
      setValidatingLocation(false)
    }
  }

  function saveCurrentAsCommonLocation(): void {
    const query = form.location.trim()
    if (!query) {
      setLocationValidationError('Enter a location before saving it as common.')
      return
    }

    const next = [...commonLocations]
    const existingIndex = next.findIndex((row) => row.query.toLowerCase() === query.toLowerCase())
    if (existingIndex >= 0) {
      next[existingIndex] = {
        ...next[existingIndex],
        label: query,
        county: lastValidatedGeo?.query.toLowerCase() === query.toLowerCase() ? lastValidatedGeo.county : next[existingIndex]?.county,
        state: lastValidatedGeo?.query.toLowerCase() === query.toLowerCase() ? lastValidatedGeo.state : next[existingIndex]?.state,
        count: (next[existingIndex]?.count ?? 0) + 1,
        lastUsedAt: new Date().toISOString(),
      }
    } else {
      next.push({
        query,
        label: lastValidatedGeo?.query.toLowerCase() === query.toLowerCase() && lastValidatedGeo.county
          ? `${query} (${lastValidatedGeo.county} County, ${lastValidatedGeo.state || 'CO'})`
          : query,
        county: lastValidatedGeo?.query.toLowerCase() === query.toLowerCase() ? lastValidatedGeo.county : undefined,
        state: lastValidatedGeo?.query.toLowerCase() === query.toLowerCase() ? lastValidatedGeo.state : undefined,
        count: 1,
        lastUsedAt: new Date().toISOString(),
      })
    }

    next.sort((a, b) => (b.count - a.count) || b.lastUsedAt.localeCompare(a.lastUsedAt))
    saveCommonLocations(next)
    setCommonLocations(next)
    setLocationValidation('Saved to common locations.')
    setLocationValidationError(null)
  }

  async function handlePolishDescription(): Promise<void> {
    const title = form.title.trim()
    const description = form.description.trim()
    if (!title || !description) {
      setAiDescriptionError('Add both a title and description before polishing with AI.')
      return
    }

    const normalizedDate = normalizeDateTimeValue(form.event_date)
    const eventDateForAi = isValid24HourDateTime(normalizedDate) ? toApiUtcDateTime(normalizedDate) : undefined

    setAiDescriptionLoading(true)
    setAiDescriptionError(null)
    try {
      const draft = await onGenerateAiDescriptionPreview({
        title,
        description,
        event_date: eventDateForAi,
        location: form.location.trim() || null,
        event_lead_name: aiLeadName,
      }, aiTone)
      setAiDescriptionProvider(draft.provider)
      setAiDescriptionDraft(draft.polished_description)
    } catch (err) {
      setAiDescriptionError(err instanceof Error ? err.message : 'Unable to polish description.')
    } finally {
      setAiDescriptionLoading(false)
    }
  }

  async function handleGenerateAiPreview(): Promise<void> {
    const normalizedDate = normalizeDateTimeValue(form.event_date)
    if (!form.title.trim() || !isValid24HourDateTime(normalizedDate)) {
      setAiDraftError('Add a title and valid event date/time before generating an AI draft.')
      return
    }

    setAiDraftLoading(true)
    setAiDraftError(null)
    try {
      const draft = await onGenerateAiDraftPreview({
        title: form.title.trim(),
        event_date: toApiUtcDateTime(normalizedDate),
        location: form.location.trim() || null,
        description: aiDescriptionDraft.trim() || form.description.trim() || null,
        event_lead_name: aiLeadName,
      }, aiTone)
      setAiDraftResult(draft)
      setAiSubjectDraft(draft.subject)
      setAiEmailDraft(draft.emailBody)
      setAiSmsDraft(draft.smsBody)
    } catch (err) {
      setAiDraftError(err instanceof Error ? err.message : 'Unable to generate AI draft preview.')
    } finally {
      setAiDraftLoading(false)
    }
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
    const typedTime = sanitizeTimeInput(rawTime)
    setDateTimeField(field, date, typedTime)
  }

  function handleDateInput(field: 'event_date' | 'end_date', rawDate: string, time: string) {
    const typedDate = normalizeDateInput(rawDate)
    setDateTimeField(field, typedDate, time)
  }

  function handleDateBlur(field: 'event_date' | 'end_date', rawDate: string, time: string) {
    const canonicalDate = toCanonicalDate(rawDate)
    if (!canonicalDate) {
      return
    }
    setDateTimeField(field, canonicalDate, time)
  }

  function handleTimeBlur(field: 'event_date' | 'end_date', date: string, rawTime: string) {
    const canonical = toCanonicalTime(rawTime)
    if (!canonical) {
      return
    }
    setDateTimeField(field, date, canonical)
  }

  async function handleSubmit() {
    const nextErrors: FormFieldErrors = {}

    if (!form.title.trim()) {
      nextErrors.title = 'Title is required.'
    }

    if (form.scheduler_email.trim()) {
      const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
      if (!emailPattern.test(form.scheduler_email.trim().toLowerCase())) {
        nextErrors.scheduler_email = 'Enter a valid email address.'
      }
    }

    if (!form.event_lead_member_id && form.event_lead_secondary_roles.length > 0) {
      nextErrors.event_lead_member_id = 'Choose an event lead before selecting lead secondary roles.'
    }

    const eventDate = toCanonicalDate(eventDateParts.date)
    const eventTime = toCanonicalTime(eventDateParts.time)
    if (!eventDate) {
      nextErrors.event_date = 'Select a valid event date.'
    }
    if (!eventTime) {
      nextErrors.event_time = 'Select a valid event time.'
    }

    let canonicalEndDate: string | null = null
    let canonicalEndTime: string | null = null
    const endHasInput = Boolean(endDateParts.date.trim() || endDateParts.time.trim())
    if (endHasInput) {
      canonicalEndDate = toCanonicalDate(endDateParts.date)
      canonicalEndTime = toCanonicalTime(endDateParts.time)
      if (!canonicalEndDate) {
        nextErrors.end_date = 'End date is invalid.'
      }
      if (!canonicalEndTime) {
        nextErrors.end_time = 'End time is invalid.'
      }
    }

    const mentorCapacity = parseCapacityValue(form.mentor_capacity)
    const participantCapacity = parseCapacityValue(form.participant_capacity)
    if (form.mentor_capacity.trim() && mentorCapacity === null) {
      nextErrors.mentor_capacity = 'Use a whole number >= 1 or leave blank.'
    }
    if (form.participant_capacity.trim() && participantCapacity === null) {
      nextErrors.participant_capacity = 'Use a whole number >= 1 or leave blank.'
    }

    if (eventDate && eventTime && canonicalEndDate && canonicalEndTime) {
      const eventValue = joinDateTime(eventDate, eventTime)
      const endValue = joinDateTime(canonicalEndDate, canonicalEndTime)
      if (new Date(endValue).getTime() < new Date(eventValue).getTime()) {
        nextErrors.end_time = 'End must be at or after start.'
      }
    }

    setFieldErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      return
    }

    await onSave({
      ...form,
      title: form.title.trim(),
      event_lead_secondary_roles: form.event_lead_member_id ? form.event_lead_secondary_roles : [],
      event_date: toApiUtcDateTime(joinDateTime(eventDate!, eventTime!)),
      end_date: endHasInput ? toApiUtcDateTime(joinDateTime(canonicalEndDate!, canonicalEndTime!)) : '',
      mentor_capacity: mentorCapacity == null ? '' : String(mentorCapacity),
      participant_capacity: participantCapacity == null ? '' : String(participantCapacity),
    })
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="event-modal-title">
      <div className="modal">
        <div className="modal__header">
          <h2 id="event-modal-title" className="modal__title">{isEdit ? 'Edit Event' : 'New Event'}</h2>
          <button className="btn btn--ghost btn--sm" type="button" aria-label="Close event editor" onClick={onCancel} disabled={saving}>✕</button>
        </div>

        <div className="modal__body">
          <div className="form-grid">
            <div className="form-field form-field--full">
              <label className="form-label">Title *</label>
              <input className="form-input" value={form.title} onChange={e => set('title', e.target.value)} required />
              {fieldErrors.title && <p className="form-field-error">{fieldErrors.title}</p>}
            </div>

            <div className="form-field">
              <label className="form-label">Event Date *</label>
              <input
                className="form-input"
                type="date"
                value={eventDateParts.date}
                onChange={e => handleDateInput('event_date', e.target.value, eventDateParts.time)}
                onBlur={e => handleDateBlur('event_date', e.target.value, eventDateParts.time)}
                required
              />
              {fieldErrors.event_date && <p className="form-field-error">{fieldErrors.event_date}</p>}
            </div>

            <div className="form-field">
              <label className="form-label">Event Time (24-hour) *</label>
              <input
                className="form-input"
                type="text"
                inputMode="numeric"
                placeholder="07:30"
                autoComplete="off"
                value={eventDateParts.time}
                onChange={e => handleTimeInput('event_date', eventDateParts.date, e.target.value)}
                onBlur={e => handleTimeBlur('event_date', eventDateParts.date, e.target.value)}
                required
              />
              {fieldErrors.event_time && <p className="form-field-error">{fieldErrors.event_time}</p>}
            </div>

            <div className="form-field">
              <label className="form-label">End Date</label>
              <input
                className="form-input"
                type="date"
                value={endDateParts.date}
                onChange={e => handleDateInput('end_date', e.target.value, endDateParts.time)}
                onBlur={e => handleDateBlur('end_date', e.target.value, endDateParts.time)}
              />
              {fieldErrors.end_date && <p className="form-field-error">{fieldErrors.end_date}</p>}
            </div>

            <div className="form-field">
              <label className="form-label">End Time (24-hour)</label>
              <input
                className="form-input"
                type="text"
                inputMode="numeric"
                placeholder="17:30"
                autoComplete="off"
                value={endDateParts.time}
                onChange={e => handleTimeInput('end_date', endDateParts.date, e.target.value)}
                onBlur={e => handleTimeBlur('end_date', endDateParts.date, e.target.value)}
              />
              {fieldErrors.end_time && <p className="form-field-error">{fieldErrors.end_time}</p>}
            </div>

            <div className="form-field form-field--full">
              <label className="form-label">Location</label>
              <input className="form-input" value={form.location} onChange={e => set('location', e.target.value)} />
              {commonLocations.length > 0 && (
                <select
                  className="form-input"
                  value=""
                  onChange={(event) => {
                    if (event.target.value) {
                      set('location', event.target.value)
                    }
                  }}
                >
                  <option value="">Use common location</option>
                  {commonLocations.slice(0, 10).map((row) => (
                    <option key={row.query} value={row.query}>{row.label}</option>
                  ))}
                </select>
              )}
              <div className="location-tools">
                <button className="btn btn--outline btn--sm" type="button" onClick={() => void validateLocation()} disabled={validatingLocation || saving}>
                  {validatingLocation ? 'Validating…' : 'Validate Address'}
                </button>
                <button className="btn btn--outline btn--sm" type="button" onClick={saveCurrentAsCommonLocation} disabled={saving}>
                  Save as Common
                </button>
                {form.location.trim() && (
                  <a
                    className="btn btn--outline btn--sm"
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(form.location.trim())}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open in Maps
                  </a>
                )}
              </div>
              {locationValidation && <p className="success-text">{locationValidation}</p>}
              {locationValidationError && <p className="form-field-error">{locationValidationError}</p>}
            </div>

            <div className="form-field form-field--full">
              <label className="form-label">Event Photo URL</label>
              <input
                className="form-input"
                value={form.photo_url}
                onChange={e => set('photo_url', e.target.value)}
                placeholder="https://..."
              />
              <p className="form-field-hint">Optional. Use an https image URL to show a photo on event cards.</p>
            </div>

            <div className="form-field">
              <label className="form-label">Invitation Stage</label>
              <select
                className="form-input"
                value={form.invitation_stage}
                onChange={e => set('invitation_stage', e.target.value as EventFormPayload['invitation_stage'])}
              >
                <option value="both">Both (single-step)</option>
                <option value="volunteer">Volunteer call first</option>
                <option value="participant">Participant call</option>
              </select>
            </div>

            <div className="form-field">
              <label className="form-label">Event Lead</label>
              <select
                className="form-input"
                value={form.event_lead_member_id}
                onChange={(e) => {
                  const memberId = e.target.value
                  setForm((current) => ({
                    ...current,
                    event_lead_member_id: memberId,
                    event_lead_secondary_roles: memberId ? current.event_lead_secondary_roles : [],
                  }))
                  setFieldErrors((prev) => ({ ...prev, event_lead_member_id: undefined }))
                }}
              >
                <option value="">None</option>
                {leadMembers.map((member) => (
                  <option key={member.member_id} value={member.member_id}>
                    {member.first_name} {member.last_name} ({member.email})
                  </option>
                ))}
              </select>
              {fieldErrors.event_lead_member_id && <p className="form-field-error">{fieldErrors.event_lead_member_id}</p>}
            </div>

            <div className="form-field form-field--full">
              <label className="form-label">Event Lead Secondary Roles</label>
              <div className="group-checks">
                <label className="group-check">
                  <input
                    type="checkbox"
                    checked={form.event_lead_secondary_roles.includes('MENTOR')}
                    onChange={() => toggleLeadSecondaryRole('MENTOR')}
                    disabled={!form.event_lead_member_id}
                  />
                  Lead also serves as Volunteer
                </label>
                <label className="group-check">
                  <input
                    type="checkbox"
                    checked={form.event_lead_secondary_roles.includes('PARTICIPANT')}
                    onChange={() => toggleLeadSecondaryRole('PARTICIPANT')}
                    disabled={!form.event_lead_member_id}
                  />
                  Lead also serves as Participant
                </label>
              </div>
              <p className="form-field-hint">Leave both unchecked when the lead should be LEAD-only.</p>
            </div>

            <div className="form-field form-field--full">
              <label className="form-label">Scheduler Email</label>
              <input className="form-input" type="email" value={form.scheduler_email} onChange={e => set('scheduler_email', e.target.value)} placeholder="scheduler@example.org" />
              <p className="form-field-hint">Used for the post-event participation summary after the event is closed. If blank, the system falls back to the event creator email when available.</p>
              {fieldErrors.scheduler_email && <p className="form-field-error">{fieldErrors.scheduler_email}</p>}
            </div>

            <div className="form-field">
              <label className="form-label">Volunteer Capacity</label>
              <input
                className="form-input"
                type="number"
                min="1"
                step="1"
                value={form.mentor_capacity}
                onChange={e => set('mentor_capacity', e.target.value)}
              />
              {fieldErrors.mentor_capacity && <p className="form-field-error">{fieldErrors.mentor_capacity}</p>}
            </div>

            <div className="form-field">
              <label className="form-label">Participant Capacity</label>
              <input
                className="form-input"
                type="number"
                min="1"
                step="1"
                value={form.participant_capacity}
                onChange={e => set('participant_capacity', e.target.value)}
              />
              <p className="form-field-hint">Leave both capacity fields blank for unlimited / kickoff-style events.</p>
              {fieldErrors.participant_capacity && <p className="form-field-error">{fieldErrors.participant_capacity}</p>}
            </div>

            <div className="form-field form-field--full">
              <label className="form-label">Description</label>
              <textarea className="form-textarea" rows={3} value={form.description} onChange={e => set('description', e.target.value)} />
            </div>

            <div className="form-field form-field--full">
              <label className="form-label">Description (Draft with AI)</label>
              <div className="event-ai-inline__toolbar">
                <button className="btn btn--outline btn--sm" type="button" onClick={() => void handlePolishDescription()} disabled={aiDescriptionLoading || saving}>
                  {aiDescriptionLoading ? 'Polishing…' : 'Polish Description with AI'}
                </button>
              </div>
              {aiDescriptionError && <p className="form-field-error">{aiDescriptionError}</p>}
              {aiDescriptionDraft && (
                <div className="event-ai-inline">
                  <p className="form-field-hint">Provider: {aiDescriptionProvider ?? 'unknown'}</p>
                  {aiDescriptionProvider === 'fallback' && (
                    <p className="form-field-error">
                      AI generation is currently unavailable, so this draft is deterministic fallback copy. Check backend AI provider configuration and runtime connectivity.
                    </p>
                  )}
                  <label className="form-label">Polished Description Draft (editable)</label>
                  <textarea className="form-textarea" rows={6} value={aiDescriptionDraft} onChange={(e) => setAiDescriptionDraft(e.target.value)} />
                  <div className="event-ai-inline__toolbar">
                    <button
                      type="button"
                      className="btn btn--outline btn--sm"
                      onClick={() => set('description', aiDescriptionDraft)}
                    >
                      Apply Edited Description
                    </button>
                  </div>
                </div>
              )}
            </div>

            <div className="form-field form-field--full">
              <label className="form-label">AI Invite Preview</label>
              <p className="form-field-hint">Preview only. Publishing uses the active Notification Templates for Event Invite, not this draft automatically.</p>
              <div className="event-ai-inline__toolbar">
                <select className="form-input event-ai-inline__tone" value={aiTone} onChange={(e) => setAiTone(e.target.value as 'friendly' | 'professional' | 'casual' | 'exciting')}>
                  <option value="friendly">Friendly</option>
                  <option value="professional">Professional</option>
                  <option value="casual">Casual</option>
                  <option value="exciting">Exciting</option>
                </select>
                <button className="btn btn--outline btn--sm" type="button" onClick={() => void handleGenerateAiPreview()} disabled={aiDraftLoading || saving}>
                  {aiDraftLoading ? 'Generating…' : 'Generate Invite from Current Description'}
                </button>
              </div>
              {aiDescriptionDraft && <p className="form-field-hint">Invite generation is using your edited polished description draft unless you clear it.</p>}
              {aiDraftError && <p className="form-field-error">{aiDraftError}</p>}
              {aiDraftResult && (
                <div className="event-ai-inline">
                  <p className="form-field-hint">Provider: {aiDraftResult.provider}</p>
                  {aiDraftResult.provider === 'fallback' && (
                    <p className="form-field-error">
                      AI generation is currently unavailable, so this invite is deterministic fallback copy. Check backend AI provider configuration and runtime connectivity.
                    </p>
                  )}
                  <label className="form-label">Subject</label>
                  <textarea className="form-textarea" rows={2} value={aiSubjectDraft} onChange={(e) => setAiSubjectDraft(e.target.value)} />
                  <label className="form-label">Email Draft</label>
                  <textarea className="form-textarea" rows={6} value={aiEmailDraft} onChange={(e) => setAiEmailDraft(e.target.value)} />
                  <label className="form-label">SMS Draft</label>
                  <textarea className="form-textarea" rows={3} value={aiSmsDraft} onChange={(e) => setAiSmsDraft(e.target.value)} />
                  {Array.isArray(aiDraftResult.imageSuggestions) && aiDraftResult.imageSuggestions.length > 0 && (
                    <div>
                      <p className="form-field-hint">Image ideas:</p>
                      <div className="event-ai-inline__toolbar">
                        {aiDraftResult.imageSuggestions.map((url) => (
                          <a key={url} className="btn btn--outline btn--sm" href={url} target="_blank" rel="noreferrer">
                            Browse Image Options
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="event-ai-inline__toolbar">
                    <button
                      type="button"
                      className="btn btn--outline btn--sm"
                      onClick={() => set('description', aiEmailDraft)}
                    >
                      Use Edited Email Draft as Description
                    </button>
                    <button
                      type="button"
                      className="btn btn--outline btn--sm"
                      onClick={() => {
                        setAiSubjectDraft(aiDraftResult.subject)
                        setAiEmailDraft(aiDraftResult.emailBody)
                        setAiSmsDraft(aiDraftResult.smsBody)
                      }}
                    >
                      Reset to AI Draft
                    </button>
                    {aiDraftResult.mapUrl && (
                      <a className="btn btn--outline btn--sm" href={aiDraftResult.mapUrl} target="_blank" rel="noreferrer">
                        Open Map Link
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>

            {isEdit && (
              <div className="form-field form-field--full">
                <label className="form-label">Update Reason</label>
                <textarea
                  className="form-textarea"
                  rows={2}
                  value={form.update_reason}
                  onChange={e => set('update_reason', e.target.value)}
                  placeholder="Explain what changed (sent to RSVP'd members)"
                />
              </div>
            )}

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
            onClick={() => void handleSubmit()}
            disabled={saving}
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
  const { isAdmin, canCreateEvents, user } = useAuth()
  const canEdit = isAdmin() || canCreateEvents()

  const [events, setEvents] = useState<EventRecord[]>([])
  const [groups, setGroups] = useState<GroupRecord[]>([])
  const [leadMembers, setLeadMembers] = useState<LeadDirectoryMember[]>([])
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

  // edit form — pre-fetched notification-target group IDs
  const [editInitialTargets, setEditInitialTargets] = useState<string[]>([])
  const [editOpenLoading, setEditOpenLoading] = useState(false)

  // status transition in-flight
  const [transitioning, setTransitioning] = useState<string | null>(null)
  const [sendingUpdateEventId, setSendingUpdateEventId] = useState<string | null>(null)
  const [sendingReminderEventId, setSendingReminderEventId] = useState<string | null>(null)
  const [reportEmailingEventId, setReportEmailingEventId] = useState<string | null>(null)
  const [memberId, setMemberId] = useState<string | null>(null)
  const [rsvpBusyEventId, setRsvpBusyEventId] = useState<string | null>(null)
  const [rsvpDraftByEvent, setRsvpDraftByEvent] = useState<Record<string, RsvpDraft>>({})

  const abortRef = useRef<AbortController | null>(null)

  function isUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  }

  const loadEvents = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()
    const signal = abortRef.current.signal
    setLoading(true)
    setErr(null)
    try {
      const data = await eventsApi.list(filter === 'all' ? undefined : filter, { signal })
      setEvents(data)
    } catch (e: unknown) {
      if (e instanceof Error && e.name !== 'AbortError') setErr(toUserErrorMessage(e, 'Unable to load events.'))
    } finally {
      setLoading(false)
    }
  }, [filter])

  useEffect(() => {
    void loadEvents()
    if (canEdit) {
      groupsApi.list().then(setGroups).catch(() => setGroups([]))
      membersApi.list({ page: 1, pageSize: 200, isActive: true })
        .then((response) => {
          const rows = response.data.map((member: MemberRecord) => ({
            member_id: member.member_id,
            first_name: member.first_name,
            last_name: member.last_name,
            email: member.email,
          }))
          setLeadMembers(rows)
        })
        .catch(() => setLeadMembers([]))
    }
  }, [loadEvents, canEdit])

  useEffect(() => {
    let active = true

    async function resolveMemberId() {
      if (!user?.email) {
        if (active) {
          setMemberId(user?.id && isUuid(user.id) ? user.id : null)
        }
        return
      }

      try {
        const list = await membersApi.list({ page: 1, pageSize: 10, search: user.email })
        const normalizedEmail = user.email.trim().toLowerCase()
        const found = list.data.find((candidate) => candidate.email.trim().toLowerCase() === normalizedEmail)?.member_id ?? null
        if (active) {
          setMemberId(found ?? (user?.id && isUuid(user.id) ? user.id : null))
        }
      } catch {
        if (active) {
          setMemberId(user?.id && isUuid(user.id) ? user.id : null)
        }
      }
    }

    void resolveMemberId()
    return () => {
      active = false
    }
  }, [user?.email, user?.id])

  async function handleSave(form: EventFormPayload) {
    setFormSaving(true)
    setFormError(null)
    try {
      const mentorCapacity = parseCapacityValue(form.mentor_capacity)
      const participantCapacity = parseCapacityValue(form.participant_capacity)
      const combinedCapacity = (mentorCapacity ?? 0) + (participantCapacity ?? 0)

      const payload = {
        title: form.title,
        event_date: form.event_date,
        description: form.description || null,
        location: form.location || null,
        photo_url: form.photo_url.trim() || null,
        invitation_stage: form.invitation_stage,
        event_lead_member_id: form.event_lead_member_id || null,
        event_lead_secondary_roles: form.event_lead_member_id ? form.event_lead_secondary_roles : [],
        scheduler_email: form.scheduler_email.trim().toLowerCase() || null,
        end_date: form.end_date || null,
        mentor_capacity: mentorCapacity,
        participant_capacity: participantCapacity,
        capacity: combinedCapacity > 0 ? combinedCapacity : null,
        notification_targets: form.notification_targets.map(id => ({ group_id: id })),
      }

      if (editTarget) {
        await eventsApi.update(editTarget.event_id, {
          ...payload,
          update_reason: form.update_reason.trim() || null,
        })
      } else {
        await eventsApi.create(payload)
      }

      setShowForm(false)
      setEditTarget(null)
      await loadEvents()
    } catch (e: unknown) {
      setFormError(toUserErrorMessage(e, 'Save failed.'))
    } finally {
      setFormSaving(false)
    }
  }

  async function handleStatusTransition(event: EventRecord, newStatus: EventRecord['status']) {
    if (newStatus === 'published') {
      if ((event.target_count ?? 0) === 0) {
        setErr('Select at least one target group before publishing this event.')
        return
      }

      const preview = [
        `Publish and send invites for "${event.title}"?`,
        '',
        `When: ${formatDate(event.event_date)}`,
        `Where: ${event.location ?? 'TBD'}`,
        '',
        'Publishing triggers invite sends. Editing later will not auto-send updates.',
      ].join('\n')
      if (!window.confirm(preview)) {
        return
      }
    }

    setTransitioning(event.event_id)
    try {
      await eventsApi.updateStatus(event.event_id, newStatus)
      // Optimistically update just this event's status so the UI responds
      // immediately — the background notification send can hold DB connections
      // briefly, which would delay a full loadEvents() reload.
      setEvents((prev) => prev.map((e) =>
        e.event_id === event.event_id ? { ...e, status: newStatus } : e
      ))
      // Refresh the full list in background without blocking the UI.
      void loadEvents()
    } catch (e: unknown) {
      setErr(toUserErrorMessage(e, 'Status change failed.'))
    } finally {
      setTransitioning(null)
    }
  }

  async function sendUpdate(event: EventRecord) {
    const updateReason = window.prompt('Update reason (sent to RSVP\'d members):', '')?.trim() ?? ''
    if (!updateReason) {
      return
    }

    if (!window.confirm('Send this update notification now?')) {
      return
    }

    setSendingUpdateEventId(event.event_id)
    try {
      await eventsApi.sendUpdate(event.event_id, {
        update_reason: updateReason,
        changed_fields: ['details'],
      })
      setErr(null)
    } catch (error) {
      setErr(toUserErrorMessage(error, 'Unable to send event update notification.'))
    } finally {
      setSendingUpdateEventId(null)
    }
  }

  async function sendReminder(event: EventRecord) {
    const preview = [
      `Send RSVP reminder to non-responders for \"${event.title}\"?`,
      '',
      'This will only contact targeted members who have not RSVP\'d yet.',
    ].join('\n')

    if (!window.confirm(preview)) {
      return
    }

    setSendingReminderEventId(event.event_id)
    try {
      await eventsApi.sendReminder(event.event_id)
      setErr(null)
    } catch (error) {
      setErr(toUserErrorMessage(error, 'Unable to send RSVP reminder.'))
    } finally {
      setSendingReminderEventId(null)
    }
  }

  function openCreate() {
    setEditTarget(null)
    setFormError(null)
    setEditInitialTargets([])
    setShowForm(true)
  }

  async function openEdit(event: EventRecord) {
    setEditOpenLoading(true)
    setFormError(null)
    try {
      const detail = await eventsApi.get(event.event_id)
      const groupIds = (detail.notification_targets as Array<{ group_id?: string }> ?? [])
        .map(t => t.group_id)
        .filter((id): id is string => typeof id === 'string')
      setEditInitialTargets(groupIds)
      setEditTarget(detail)
      setShowForm(true)
    } catch (e: unknown) {
      setFormError(toUserErrorMessage(e, 'Failed to load event details.'))
    } finally {
      setEditOpenLoading(false)
    }
  }

  function closeForm() {
    setShowForm(false)
    setEditTarget(null)
    setFormError(null)
    setEditInitialTargets([])
  }

  async function downloadIcs(event: EventRecord) {
    try {
      const { blob, headers } = await eventsApi.downloadIcs(event.event_id)
      downloadBlobFile(blob, headers, suggestedIcsFilename(event))
    } catch (error) {
      setErr(toUserErrorMessage(error, 'Failed to download ICS file.'))
    }
  }

  async function downloadReportCsv(event: EventRecord) {
    try {
      const { blob, headers } = await eventsApi.downloadReportCsv(event.event_id)
      downloadBlobFile(blob, headers, `event-report-${event.event_id}.csv`)
    } catch (error) {
      setErr(toUserErrorMessage(error, 'Failed to download event CSV report.'))
    }
  }

  async function downloadReportText(event: EventRecord) {
    try {
      const { blob, headers } = await eventsApi.downloadReportText(event.event_id)
      downloadBlobFile(blob, headers, `event-report-${event.event_id}.txt`)
    } catch (error) {
      setErr(toUserErrorMessage(error, 'Failed to download event record summary.'))
    }
  }

  async function downloadReportPdf(event: EventRecord) {
    try {
      const { blob, headers } = await eventsApi.downloadReportPdf(event.event_id)
      downloadBlobFile(blob, headers, `event-report-${event.event_id}.pdf`)
    } catch (error) {
      setErr(toUserErrorMessage(error, 'Failed to download event PDF report.'))
    }
  }

  async function emailEventRecord(event: EventRecord) {
    setReportEmailingEventId(event.event_id)
    try {
      await eventsApi.emailReport(event.event_id)
      setErr(null)
    } catch (error) {
      const message = toUserErrorMessage(error, 'Failed to email event record.')
      if (message.includes('No recipients configured')) {
        const recipientInput = window.prompt(
          'No default recipients configured. Enter recipient email(s), comma-separated:',
          ''
        )

        if (recipientInput) {
          const recipients = parseRecipientInput(recipientInput)
          const invalid = recipients.filter((email) => !isValidEmailAddress(email))

          if (recipients.length === 0 || invalid.length > 0) {
            setErr('Invalid recipient list. Enter one or more valid email addresses separated by commas.')
          } else {
            try {
              await eventsApi.emailReport(event.event_id, recipients)
              setErr(null)
            } catch (retryError) {
              setErr(toUserErrorMessage(retryError, 'Failed to email event record.'))
            }
          }
        } else {
          setErr('Email record canceled. Configure EVENT_RECORD_EMAIL_TO in backend/.env to avoid manual recipient entry.')
        }
      } else {
        setErr(message)
      }
    } finally {
      setReportEmailingEventId(null)
    }
  }

  function ensureCompletedForReport(event: EventRecord, actionLabel: string): boolean {
    if (event.status === 'completed') {
      return true
    }
    setErr(`Set this event status to Completed before using ${actionLabel}.`)
    return false
  }

  function getRsvpDraft(eventId: string): RsvpDraft {
    return rsvpDraftByEvent[eventId] ?? DEFAULT_RSVP_DRAFT
  }

  function setRsvpDraft(eventId: string, next: Partial<RsvpDraft>) {
    setRsvpDraftByEvent((prev) => ({
      ...prev,
      [eventId]: {
        ...(prev[eventId] ?? DEFAULT_RSVP_DRAFT),
        ...next,
      },
    }))
  }

  async function submitRsvp(event: EventRecord) {
    if (event.status !== 'published') {
      setErr('RSVP updates are only available for published events.')
      return
    }

    const draft = getRsvpDraft(event.event_id)

    setRsvpBusyEventId(event.event_id)
    try {
      await rsvpApi.upsert(event.event_id, {
        member_id: memberId ?? undefined,
        response: draft.response,
        response_role: draft.response === 'yes' || draft.response === 'maybe' ? draft.role : undefined,
      })
      setErr(null)
      await loadEvents()
    } catch (error) {
      setErr(toUserErrorMessage(error, 'Unable to update RSVP from the Events page.'))
    } finally {
      setRsvpBusyEventId(null)
    }
  }

  async function generateAiDraftPreview(
    payload: { title: string; event_date: string; location?: string | null; description?: string | null; event_lead_name?: string | null },
    tone: 'friendly' | 'professional' | 'casual' | 'exciting'
  ) {
    return eventsApi.generateAiDraftPreview(payload, tone)
  }

  async function generateAiDescriptionPreview(
    payload: { title: string; description: string; event_date?: string; location?: string | null; event_lead_name?: string | null },
    tone: 'friendly' | 'professional' | 'casual' | 'exciting'
  ) {
    return eventsApi.generateAiDescriptionPreview(payload, tone)
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

      {err && <p className="ui-notice ui-notice--error">{err}</p>}
      {loading && (
        <div className="phw-skeleton-grid">
          <LoadingSkeleton lines={4} />
          <LoadingSkeleton lines={4} />
          <LoadingSkeleton lines={4} />
        </div>
      )}

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
                <SlotCount
                  yesCount={event.yes_count ?? 0}
                  capacity={event.capacity}
                  mentorCapacity={event.mentor_capacity}
                  participantCapacity={event.participant_capacity}
                />
              </div>

              <h2 className="event-card__title">{event.title}</h2>
              {event.photo_url && (
                <div className="event-card__image-wrap">
                  <img className="event-card__image" src={event.photo_url} alt={`${event.title} event`} loading="lazy" />
                </div>
              )}
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

                  <div className="event-rsvp-inline" role="group" aria-label={`RSVP controls for ${event.title}`}>
                    <select
                      id={`rsvp-response-${event.event_id}`}
                      name={`rsvp-response-${event.event_id}`}
                      className="form-input event-rsvp-inline__response"
                      value={getRsvpDraft(event.event_id).response}
                      onChange={(e) => setRsvpDraft(event.event_id, { response: e.target.value as RsvpDraft['response'] })}
                      disabled={rsvpBusyEventId === event.event_id}
                      title="RSVP response"
                    >
                      <option value="yes">Attending</option>
                      <option value="maybe">Maybe</option>
                      <option value="no">Cannot Attend</option>
                    </select>

                    <select
                      id={`rsvp-role-${event.event_id}`}
                      name={`rsvp-role-${event.event_id}`}
                      className="form-input event-rsvp-inline__role"
                      value={getRsvpDraft(event.event_id).role}
                      onChange={(e) => setRsvpDraft(event.event_id, { role: e.target.value as RsvpDraft['role'] })}
                      disabled={rsvpBusyEventId === event.event_id || getRsvpDraft(event.event_id).response === 'no'}
                      title="RSVP role"
                    >
                      <option value="PARTICIPANT">as Participant</option>
                      <option value="MENTOR">as Volunteer</option>
                    </select>

                    <button
                      className="btn btn--outline btn--sm"
                      onClick={() => void submitRsvp(event)}
                      disabled={event.status !== 'published' || rsvpBusyEventId === event.event_id}
                      title={event.status !== 'published' ? 'Available when event is published' : undefined}
                    >
                      {rsvpBusyEventId === event.event_id ? 'Saving…' : 'Save RSVP'}
                    </button>
                  </div>

                  <button className="btn btn--outline btn--sm" onClick={() => void downloadIcs(event)}>
                    ICS
                  </button>

                  {canEdit && (
                    <>
                      <button
                        className="btn btn--outline btn--sm"
                        onClick={() => {
                          if (!ensureCompletedForReport(event, 'CSV export')) return
                          void downloadReportCsv(event)
                        }}
                        title={event.status !== 'completed' ? 'Set status to Completed to enable report export' : undefined}
                      >
                        CSV
                      </button>

                      <button
                        className="btn btn--outline btn--sm"
                        onClick={() => {
                          if (!ensureCompletedForReport(event, 'PDF export')) return
                          void downloadReportPdf(event)
                        }}
                        title={event.status !== 'completed' ? 'Set status to Completed to enable report export' : undefined}
                      >
                        PDF
                      </button>

                      <button
                        className="btn btn--outline btn--sm"
                        onClick={() => {
                          if (!ensureCompletedForReport(event, 'event record export')) return
                          void downloadReportText(event)
                        }}
                        title={event.status !== 'completed' ? 'Set status to Completed to enable report export' : undefined}
                      >
                        Record
                      </button>
                    </>
                  )}

                  {canEdit && (
                    <button
                      className="btn btn--outline btn--sm"
                      onClick={() => void openEdit(event)}
                      disabled={editOpenLoading}
                    >
                      {editOpenLoading ? 'Loading…' : 'Edit'}
                    </button>
                  )}

                  {isAdmin() && (
                    <button className="btn btn--outline btn--sm" onClick={() => navigate(`/events/${event.event_id}/manage`)}>
                      Manage
                    </button>
                  )}

                  {canEdit && (
                    <button
                      className="btn btn--outline btn--sm"
                      onClick={() => {
                        if (!ensureCompletedForReport(event, 'Lead Summary')) return
                        void emailEventRecord(event)
                      }}
                      disabled={reportEmailingEventId === event.event_id}
                      title={event.status !== 'completed' ? 'Set status to Completed to enable the lead summary email' : undefined}
                    >
                      {reportEmailingEventId === event.event_id ? 'Sending…' : 'Lead Summary'}
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

                  {canEdit && event.status === 'published' && (
                    <button
                      className="btn btn--outline btn--sm"
                      onClick={() => void sendReminder(event)}
                      disabled={sendingReminderEventId === event.event_id}
                    >
                      {sendingReminderEventId === event.event_id ? 'Sending…' : 'Send Reminder'}
                    </button>
                  )}

                  {canEdit && event.status === 'published' && (
                    <button
                      className="btn btn--outline btn--sm"
                      onClick={() => void sendUpdate(event)}
                      disabled={sendingUpdateEventId === event.event_id}
                    >
                      {sendingUpdateEventId === event.event_id ? 'Sending…' : 'Send Update'}
                    </button>
                  )}
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
          initial={editTarget ? { ...payloadFromRecord(editTarget), notification_targets: editInitialTargets } : buildDefaultEventForm()}
          groups={groups}
          leadMembers={leadMembers}
          onSave={handleSave}
          onGenerateAiDescriptionPreview={generateAiDescriptionPreview}
          onGenerateAiDraftPreview={generateAiDraftPreview}
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
