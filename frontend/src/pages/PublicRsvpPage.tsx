import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { emailRsvpApi } from '../api/events'
import type { PublicRsvpContext, RsvpRecord } from '../api/events'

type ResponseRole = 'MENTOR' | 'PARTICIPANT'

const RESPONSE_OPTIONS: Array<{ value: RsvpRecord['response']; label: string; className: string }> = [
  { value: 'yes', label: 'Yes', className: 'public-rsvp__option--yes' },
  { value: 'no', label: 'No', className: 'public-rsvp__option--no' },
  { value: 'maybe', label: 'Maybe', className: 'public-rsvp__option--maybe' },
  { value: 'waitlist', label: 'Waitlist', className: 'public-rsvp__option--waitlist' },
]

function formatDate(value: string) {
  return new Date(value).toLocaleString('en-GB', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function PublicRsvpPage() {
  const { token = '' } = useParams()
  const [searchParams] = useSearchParams()
  const preset = searchParams.get('response') as RsvpRecord['response'] | null
  const presetRoleParam = searchParams.get('role')
  const presetRole = (presetRoleParam && (presetRoleParam.toUpperCase() === 'MENTOR' || presetRoleParam.toUpperCase() === 'PARTICIPANT'))
    ? (presetRoleParam.toUpperCase() as ResponseRole)
    : null
  const [context, setContext] = useState<PublicRsvpContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selectedRole, setSelectedRole] = useState<ResponseRole | ''>('')
  const autoSubmitted = useRef(false)

  const roleRequiredResponses: Array<RsvpRecord['response']> = ['yes', 'maybe', 'waitlist']

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!token) {
        setError('Missing RSVP token.')
        setLoading(false)
        return
      }

      setLoading(true)
      setError(null)

      try {
        const data = await emailRsvpApi.get(token)
        if (cancelled) {
          return
        }

        setContext(data)
        if (data.current_response_role === 'MENTOR' || data.current_response_role === 'PARTICIPANT') {
          setSelectedRole(data.current_response_role)
        } else if (data.inferred_response_role === 'MENTOR' || data.inferred_response_role === 'PARTICIPANT') {
          setSelectedRole(data.inferred_response_role)
        } else if (presetRole) {
          setSelectedRole(presetRole)
        }
        setNotice(data.current_response ? `Current RSVP: ${data.current_response}${data.current_response_role ? ` (${data.current_response_role})` : ''}` : null)

        if (preset && RESPONSE_OPTIONS.some((option) => option.value === preset) && !autoSubmitted.current && data.status === 'published') {
          const needsRole = roleRequiredResponses.includes(preset)
          if (needsRole && !presetRole) {
            return
          }

          autoSubmitted.current = true

          if (data.current_response === preset && (!needsRole || data.current_response_role === presetRole)) {
            setNotice(`Your RSVP is already recorded as ${preset}${presetRole ? ` (${presetRole})` : ''}.`)
            return
          }

          await submitResponse(token, preset, needsRole ? presetRole : selectedRole || undefined, setContext, setNotice, setError, setSubmitting)
        }
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : 'Unable to load RSVP invite.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [preset, presetRole, token])

  async function handleSubmit(response: RsvpRecord['response']) {
    if (!token) {
      return
    }

    const requiresRole = roleRequiredResponses.includes(response)
    if (requiresRole && !selectedRole) {
      setError('Select Mentor or Participant before saving this RSVP response.')
      return
    }

    await submitResponse(token, response, selectedRole || undefined, setContext, setNotice, setError, setSubmitting)
  }

  return (
    <div className="login-page public-rsvp-page">
      <div className="login-card public-rsvp-card">
        <p className="public-rsvp__eyebrow">Event RSVP</p>
        <h1 className="login-card__title">Project Healing Waters Alpine Events</h1>

        {loading && <p className="login-card__desc">Loading your invite…</p>}
        {!loading && error && <p className="public-rsvp__error">{error}</p>}

        {!loading && !error && context && (
          <>
            <h2 className="public-rsvp__title">{context.title}</h2>
            <p className="public-rsvp__meta">For {context.first_name ?? 'member'} · {formatDate(context.event_date)}</p>
            <p className="public-rsvp__meta">{context.location ?? 'Location to be announced'}</p>
            {context.description && <p className="login-card__desc">{context.description}</p>}
            <p className="public-rsvp__status">Event status: <strong>{context.status}</strong></p>
            {context.token_expires_at && <p className="public-rsvp__expires">Link expires {formatDate(context.token_expires_at)}</p>}

            <fieldset className="public-rsvp__role-picker">
              <legend>Select RSVP role</legend>
              <label>
                <input
                  type="radio"
                  name="response-role"
                  value="MENTOR"
                  checked={selectedRole === 'MENTOR'}
                  onChange={() => setSelectedRole('MENTOR')}
                  disabled={submitting || context.status !== 'published'}
                />
                Mentor
              </label>
              <label>
                <input
                  type="radio"
                  name="response-role"
                  value="PARTICIPANT"
                  checked={selectedRole === 'PARTICIPANT'}
                  onChange={() => setSelectedRole('PARTICIPANT')}
                  disabled={submitting || context.status !== 'published'}
                />
                Participant
              </label>
            </fieldset>

            {notice && <p className="public-rsvp__notice">{notice}</p>}

            <div className="public-rsvp__actions">
              {RESPONSE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  className={`btn public-rsvp__option ${option.className}`}
                  disabled={submitting || context.status !== 'published'}
                  onClick={() => void handleSubmit(option.value)}
                >
                  {submitting ? 'Saving…' : option.label}
                </button>
              ))}
            </div>

            {context.status !== 'published' && (
              <p className="public-rsvp__error">This event is not currently accepting RSVP changes.</p>
            )}
          </>
        )}

        <div className="login-card__links">
          <Link to="/login">Sign in</Link>
          <Link to="/privacy">Privacy Policy</Link>
          <Link to="/terms">Terms</Link>
        </div>
      </div>
    </div>
  )
}

async function submitResponse(
  token: string,
  response: RsvpRecord['response'],
  responseRole: ResponseRole | undefined,
  setContext: Dispatch<SetStateAction<PublicRsvpContext | null>>,
  setNotice: Dispatch<SetStateAction<string | null>>,
  setError: Dispatch<SetStateAction<string | null>>,
  setSubmitting: Dispatch<SetStateAction<boolean>>,
) {
  setSubmitting(true)
  setError(null)

  try {
    const record = await emailRsvpApi.submit(token, { response, response_role: responseRole })
    setContext((current) => current ? { ...current, current_response: record.response, current_response_role: record.response_role ?? current.current_response_role } : current)
    setNotice(`RSVP recorded as ${record.response}${record.response_role ? ` (${record.response_role})` : ''}.`)
  } catch (requestError) {
    setError(requestError instanceof Error ? requestError.message : 'Unable to record RSVP.')
  } finally {
    setSubmitting(false)
  }
}

export { PublicRsvpPage }