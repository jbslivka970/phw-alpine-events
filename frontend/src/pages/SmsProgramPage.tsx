import { Link } from 'react-router-dom'

function SmsProgramPage() {
  const consentArtifactPath = '/compliance/sms-consent-artifact.svg'

  return (
    <div className="legal-page">
      <div className="legal-page__shell">
        <div className="legal-page__crumbs">
          <Link to="/login">Back to sign in</Link>
        </div>

        <header className="legal-page__header">
          <p className="legal-page__eyebrow">Verification Artifact</p>
          <h1 className="legal-page__title">SMS Program and Consent</h1>
          <p className="legal-page__subtitle">
            This public page documents the PHW Alpine SMS program, opt-in language, and
            sample message templates for Azure Communication Services toll-free verification.
          </p>
        </header>

        <section className="legal-section">
          <h2>Program Description</h2>
          <p>
            Project Healing Waters Colorado Alpine Program sends informational SMS messages to
            members about event invitations, RSVP reminders, schedule changes, and chapter
            event logistics.
          </p>
        </section>

        <section className="legal-section">
          <h2>Program Content Type</h2>
          <p>Informational and customer-care messaging related to chapter events.</p>
        </section>

        <section className="legal-section">
          <h2>Opt-In Method</h2>
          <p>
            Members opt in through a chapter-managed web workflow or member profile update
            that requires explicit consent before SMS is enabled.
          </p>

          <p>
            Existing members can manage their notification preferences after signing in at{' '}
            <Link to="/preferences">Notification Preferences</Link>.
          </p>

          <div className="artifact-card">
            <div className="artifact-card__header">
              <h3>Screenshot-Ready Consent Example</h3>
              <span>Use this exact artifact as verification support</span>
            </div>

            <p>
              Direct artifact URL for submission:{' '}
              <a href={consentArtifactPath} target="_blank" rel="noreferrer">https://app.phwcoloradoalpine.org/compliance/sms-consent-artifact.svg</a>
            </p>

            <img
              src={consentArtifactPath}
              alt="SMS consent artifact showing unchecked opt-in language and Save preferences action"
              style={{ width: '100%', height: 'auto', borderRadius: 12, border: '1px solid #d7dce5' }}
            />

            <p className="consent-demo__note">
              This page renders the same standalone file linked above, so reviewer view and user view match exactly.
            </p>
          </div>
        </section>

        <section className="legal-section">
          <h2>Message Templates</h2>
          <div className="template-grid">
            <article className="artifact-card">
              <div className="artifact-card__header">
                <h3>1. Opt-In Confirmation</h3>
              </div>
              <p>
                PHW Alpine: You are subscribed to chapter event texts. Message frequency
                varies. Msg&amp;data rates may apply. Reply HELP for help or STOP to opt out.
              </p>
            </article>

            <article className="artifact-card">
              <div className="artifact-card__header">
                <h3>2. Event Invitation</h3>
              </div>
              <p>
                PHW Alpine: You are invited to Fly Fishing Outing on May 4 at Deckers. RSVP
                at the event link provided. Reply STOP to opt out.
              </p>
            </article>

            <article className="artifact-card">
              <div className="artifact-card__header">
                <h3>3. Reminder</h3>
              </div>
              <p>
                PHW Alpine: Reminder: your scheduled event is coming up soon. Check your
                event link for details. Reply STOP to opt out.
              </p>
            </article>

            <article className="artifact-card">
              <div className="artifact-card__header">
                <h3>4. Help / Support</h3>
              </div>
              <p>
                PHW Alpine: Help for chapter event texts is available through Colorado Alpine
                Program leadership. Reply STOP to opt out. See Terms and Privacy pages for
                program details.
              </p>
            </article>
          </div>
        </section>
      </div>
    </div>
  )
}

export { SmsProgramPage }