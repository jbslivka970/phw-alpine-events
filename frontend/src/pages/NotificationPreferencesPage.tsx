import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { membersApi, type MemberRecord } from '../api/members'
import { useAuth } from '../hooks/useAuth'

type ChannelPreference = 'email_only' | 'sms_only' | 'both'

function deriveChannelPreference(member: MemberRecord): ChannelPreference {
  if (member.sms_opt_in && !member.email_opt_out) {
    return 'both'
  }
  if (member.sms_opt_in && member.email_opt_out) {
    return 'sms_only'
  }
  return 'email_only'
}

function NotificationPreferencesPage() {
  const { user } = useAuth()
  const [member, setMember] = useState<MemberRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    let active = true

    async function loadMember() {
      if (!user?.email) {
        if (active) {
          setLoading(false)
          setError('No member profile is available for this session.')
        }
        return
      }

      try {
        setLoading(true)
        setError(null)
        const list = await membersApi.list({ page: 1, pageSize: 10, search: user.email })
        const normalizedEmail = user.email.trim().toLowerCase()
        const record = list.data.find((candidate) => candidate.email.trim().toLowerCase() === normalizedEmail) ?? null
        if (!record) {
          throw new Error('No member profile is available for this account email.')
        }
        if (active) {
          setMember(record)
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Unable to load your notification preferences.')
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    void loadMember()

    return () => {
      active = false
    }
  }, [user?.email])

  async function handleChannelPreferenceChange(nextPreference: ChannelPreference) {
    if (!member) {
      return
    }

    try {
      setSaving(true)
      setError(null)
      setNotice(null)
      const updated = await membersApi.updateChannelPreference(member.member_id, nextPreference)
      setMember(updated)
      if (nextPreference === 'both') {
        setNotice('You will receive both email and SMS updates for chapter events.')
      } else if (nextPreference === 'sms_only') {
        setNotice('You will receive SMS-only updates. Email notifications are opted out.')
      } else {
        setNotice('You will receive email-only updates. SMS notifications are opted out.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update notification preferences.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="page">
      <h1 className="page__title">Notification Preferences</h1>
      <p className="page__subtitle">
        Manage how Project Healing Waters Colorado Alpine Chapter contacts you about events.
      </p>

      <div className="card-grid">
        <section className="card">
          <h2 className="card__title">Notification Channels</h2>

          {loading && <p className="card__body">Loading your member profile…</p>}
          {!loading && error && <p className="error-text">{error}</p>}

          {!loading && member && (
            <div className="preferences-panel">
              <p className="card__body">
                Preferred channels:{' '}
                <strong>{deriveChannelPreference(member).replace('_', ' ')}</strong>
              </p>
              <p className="card__body">
                Mobile number: <strong>{member.mobile_phone ?? 'No mobile number on file'}</strong>
              </p>
              <p className="card__body">
                Email status:{' '}
                <strong>{member.email_opt_out ? 'Opted out' : 'Opted in'}</strong>
              </p>
              <p className="card__body">
                SMS status:{' '}
                <strong>{member.sms_opt_in ? 'Opted in' : 'Opted out'}</strong>
              </p>
              {member.sms_opt_in_date && (
                <p className="card__body">
                  Opted in since: <strong>{new Date(member.sms_opt_in_date).toLocaleString()}</strong>
                </p>
              )}
              {member.sms_opt_out_date && !member.sms_opt_in && (
                <p className="card__body">
                  Last opted out: <strong>{new Date(member.sms_opt_out_date).toLocaleString()}</strong>
                </p>
              )}

              <label className="members-search-label" htmlFor="notification-channel-preference">Choose channels</label>
              <select
                id="notification-channel-preference"
                className="members-input"
                value={deriveChannelPreference(member)}
                disabled={saving}
                onChange={(event) => {
                  void handleChannelPreferenceChange(event.target.value as ChannelPreference)
                }}
              >
                <option value="email_only">Email only</option>
                <option value="sms_only" disabled={!member.mobile_phone}>SMS only</option>
                <option value="both" disabled={!member.mobile_phone}>Both email and SMS</option>
              </select>
              <p className="card__body">
                SMS messages may include RSVP reminders and event updates. Message frequency varies.
                Message and data rates may apply. Reply STOP to opt out and HELP for help.
              </p>

              {!member.mobile_phone && (
                <p className="card__body">
                  A mobile number is required before SMS can be enabled. Contact a chapter
                  administrator to update your profile.
                </p>
              )}

              {notice && <p className="success-text">{notice}</p>}
            </div>
          )}
        </section>

        <section className="card">
          <h2 className="card__title">Program Terms</h2>
          <p className="card__body">
            SMS messages identify PHW Alpine and include opt-out instructions. Opting out of
            SMS does not remove you from the chapter roster or email communications.
          </p>
          <p className="card__body">
            Review the <Link to="/privacy">Privacy Policy</Link>,{' '}
            <Link to="/terms">Terms and Conditions</Link>, and{' '}
            <Link to="/sms-program">SMS Program</Link> pages for the public program details.
          </p>
        </section>
      </div>
    </div>
  )
}

export { NotificationPreferencesPage }