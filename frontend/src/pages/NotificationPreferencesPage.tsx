import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { membersApi, type MemberRecord, type SmsConsentLogRow, type SmsRolloutStatusResponse } from '../api/members'
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
  const [smsConsentChecked, setSmsConsentChecked] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [consentLog, setConsentLog] = useState<SmsConsentLogRow[]>([])
  const [consentLogError, setConsentLogError] = useState<string | null>(null)
  const [smsRolloutStatus, setSmsRolloutStatus] = useState<SmsRolloutStatusResponse | null>(null)

  function smsRolloutMessage(status: SmsRolloutStatusResponse | null): string | null {
    if (!status || status.sms_rollout_enabled) {
      return null
    }

    if (status.reason === 'group_allowlist') {
      return 'SMS enrollment will be enabled once your account is assigned to an approved rollout group.'
    }

    if (status.reason === 'missing_member_email') {
      return 'SMS enrollment is unavailable because this account is missing an email address.'
    }

    return 'SMS enrollment is not enabled for this account yet. Contact an administrator to join the rollout cohort.'
  }

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
          setSmsConsentChecked(Boolean(record.sms_opt_in))
        }

        try {
          const rolloutStatus = await membersApi.smsRolloutStatus(record.member_id)
          if (active) {
            setSmsRolloutStatus(rolloutStatus)
          }
        } catch {
          if (active) {
            setSmsRolloutStatus(null)
          }
        }

        try {
          const consentRows = await membersApi.consentLog(record.member_id)
          if (active) {
            setConsentLog(consentRows)
            setConsentLogError(null)
          }
        } catch (consentErr) {
          if (active) {
            setConsentLog([])
            setConsentLogError(consentErr instanceof Error ? consentErr.message : 'Unable to load SMS consent history.')
          }
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
      setSmsConsentChecked(Boolean(updated.sms_opt_in))
      if (nextPreference === 'both') {
        setNotice('You will receive both email and SMS updates for chapter events.')
      } else if (nextPreference === 'sms_only') {
        setNotice('You will receive SMS-only updates. Email notifications are opted out.')
      } else {
        setNotice('You will receive email-only updates. SMS notifications are opted out.')
      }

      try {
        const rolloutStatus = await membersApi.smsRolloutStatus(member.member_id)
        setSmsRolloutStatus(rolloutStatus)
      } catch {
        setSmsRolloutStatus(null)
      }

      try {
        const consentRows = await membersApi.consentLog(member.member_id)
        setConsentLog(consentRows)
        setConsentLogError(null)
      } catch (consentErr) {
        setConsentLog([])
        setConsentLogError(consentErr instanceof Error ? consentErr.message : 'Unable to load SMS consent history.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update notification preferences.')
    } finally {
      setSaving(false)
    }
  }

  async function handleSmsConsentSave() {
    if (!member) {
      return
    }

    if (smsRolloutStatus && !smsRolloutStatus.sms_rollout_enabled && smsConsentChecked) {
      setError('SMS enrollment is not enabled for this account yet.')
      return
    }

    if (smsConsentChecked && !member.mobile_phone) {
      setError('A mobile number is required before SMS can be enabled.')
      return
    }

    if (smsConsentChecked === member.sms_opt_in) {
      setNotice('No consent change detected. Update the checkbox and click Save preferences.')
      return
    }

    const nextPreference: ChannelPreference = smsConsentChecked
      ? (member.email_opt_out ? 'sms_only' : 'both')
      : 'email_only'

    await handleChannelPreferenceChange(nextPreference)
  }

  return (
    <div className="page">
      <h1 className="page__title">Notification Preferences</h1>
      <p className="page__subtitle">
        Manage how Project Healing Waters Colorado Alpine Program contacts you about events.
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

              <div className="sms-consent-panel" aria-live="polite">
                <h3 className="card__title">SMS Consent</h3>
                <p className="card__body">
                  Members can opt in to receive event invitation, RSVP reminder, and program update texts.
                </p>
                <label className="members-search-label" htmlFor="sms-consent-phone">Mobile phone number</label>
                <input
                  id="sms-consent-phone"
                  className="members-input"
                  value={member.mobile_phone ?? ''}
                  readOnly
                  placeholder="No mobile number on file"
                />
                <label className="members-checkbox sms-consent-checkbox" htmlFor="sms-consent-checkbox">
                  <input
                    id="sms-consent-checkbox"
                    type="checkbox"
                    checked={smsConsentChecked}
                    disabled={saving || !member.mobile_phone || (Boolean(smsRolloutStatus) && !smsRolloutStatus.sms_rollout_enabled)}
                    onChange={(event) => {
                      setNotice(null)
                      setSmsConsentChecked(event.target.checked)
                    }}
                  />
                  <span>
                    I agree to receive SMS messages from Project Healing Waters Colorado Alpine Program
                    related to event invitations, RSVP reminders, and program updates. Message frequency
                    varies. Message and data rates may apply. Reply STOP to opt out and HELP for help.
                  </span>
                </label>
                <p className="card__body">
                  Consent is not a condition of registration.
                </p>
                <p className="card__body">
                  See our <Link to="/privacy">Privacy Policy</Link> and <Link to="/terms">Terms and Conditions</Link>. Your
                  mobile information will not be sold or shared with third parties for promotional or marketing purposes.
                </p>
                {smsRolloutMessage(smsRolloutStatus) && (
                  <p className="error-text">{smsRolloutMessage(smsRolloutStatus)}</p>
                )}
                <button
                  type="button"
                  className="btn btn--primary"
                  disabled={saving || !member.mobile_phone || (Boolean(smsRolloutStatus) && !smsRolloutStatus.sms_rollout_enabled)}
                  onClick={() => {
                    void handleSmsConsentSave()
                  }}
                >
                  Save preferences
                </button>
              </div>

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

              <label className="members-search-label" htmlFor="notification-channel-preference">Advanced channel setting</label>
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
                <option value="sms_only" disabled={!member.mobile_phone || (Boolean(smsRolloutStatus) && !smsRolloutStatus.sms_rollout_enabled)}>SMS only</option>
                <option value="both" disabled={!member.mobile_phone || (Boolean(smsRolloutStatus) && !smsRolloutStatus.sms_rollout_enabled)}>Both email and SMS</option>
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

        <section className="card">
          <h2 className="card__title">SMS Consent Audit Trail</h2>
          <p className="card__body">
            Use this section for compliance screenshots showing opt-in and opt-out timestamps for your account.
          </p>
          {consentLogError && <p className="error-text">{consentLogError}</p>}
          {!consentLogError && consentLog.length === 0 && (
            <p className="card__body">No SMS consent entries recorded yet.</p>
          )}
          {!consentLogError && consentLog.length > 0 && (
            <div className="summary-table-wrapper" style={{ marginTop: '0.75rem' }}>
              <table className="summary-table">
                <thead>
                  <tr>
                    <th>Recorded At</th>
                    <th>Action</th>
                    <th>Source</th>
                    <th>Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {consentLog.slice(0, 12).map((row) => (
                    <tr key={row.consent_log_id}>
                      <td>{new Date(row.recorded_at).toLocaleString()}</td>
                      <td>{row.action}</td>
                      <td>{row.source}</td>
                      <td>{row.notes ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export { NotificationPreferencesPage }