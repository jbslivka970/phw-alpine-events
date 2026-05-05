import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { emailRsvpApi } from '../api/events'

function ShortRsvpRedirectPage() {
  const { code = '' } = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function resolveAndRedirect() {
      if (!code) {
        setError('Missing RSVP code.')
        return
      }

      try {
        const data = await emailRsvpApi.resolveShort(code)
        if (cancelled) {
          return
        }

        const query = searchParams.toString()
        const suffix = query ? `?${query}` : ''
        navigate(`/rsvp/${encodeURIComponent(data.token)}${suffix}`, { replace: true })
      } catch (requestError) {
        if (!cancelled) {
          setError(requestError instanceof Error ? requestError.message : 'Unable to open RSVP link.')
        }
      }
    }

    void resolveAndRedirect()
    return () => {
      cancelled = true
    }
  }, [code, navigate, searchParams])

  return (
    <div className="login-page public-rsvp-page">
      <div className="login-card public-rsvp-card">
        <p className="public-rsvp__eyebrow">Event RSVP</p>
        <h1 className="login-card__title">Project Healing Waters Alpine Events</h1>
        {!error && <p className="login-card__desc">Opening your invite…</p>}
        {error && <p className="public-rsvp__error">{error}</p>}
      </div>
    </div>
  )
}

export { ShortRsvpRedirectPage }
