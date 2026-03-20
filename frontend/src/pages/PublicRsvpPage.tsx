import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { emailRsvpApi } from '../api/events'
import type { PublicRsvpContext, RsvpRecord } from '../api/events'

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
  const [context, setContext] = useState<PublicRsvpContext | null>(null)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const autoSubmitted = useRef(false)

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
        setNotice(data.current_response ? `Current RSVP: ${data.current_response}` : null)

        if (preset && RESPONSE_OPTIONS.some((option) => option.value === preset) && !autoSubmitted.current && data.status === 'published') {
          autoSubmitted.current = true

          if (data.current_response === preset) {
            setNotice(`Your RSVP is already recorded as ${preset}.`)
            return
          }

          await submitResponse(token, preset, setContext, setNotice, setError, setSubmitting)
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
  }, [preset, token])

  async function handleSubmit(response: RsvpRecord['response']) {
    if (!token) {
      return
    }

    await submitResponse(token, response, setContext, setNotice, setError, setSubmitting)
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
  setContext: Dispatch<SetStateAction<PublicRsvpContext | null>>,
  setNotice: Dispatch<SetStateAction<string | null>>,
  setError: Dispatch<SetStateAction<string | null>>,
  setSubmitting: Dispatch<SetStateAction<boolean>>,
) {
  setSubmitting(true)
  setError(null)

  try {
    const record = await emailRsvpApi.submit(token, { response })
    setContext((current) => current ? { ...current, current_response: record.response } : current)
    setNotice(`RSVP recorded as ${record.response}.`)
  } catch (requestError) {
    setError(requestError instanceof Error ? requestError.message : 'Unable to record RSVP.')
  } finally {
    setSubmitting(false)
  }
}

export { PublicRsvpPage }