import { Link } from 'react-router-dom'

function SmsProgramPage() {
  const consentArtifactPath = '/images/sms-consent.png'
  const consentEnabledArtifactPath = '/images/sms-consent-actual.png'
  const consentArtifactPagePath = '/compliance/sms-consent-artifact.html'

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
            Web opt-in: The user navigates to https://app.phwcoloradoalpine.org and subscribes via
            the SMS consent form during registration or in Notification Preferences. The form states:
            "I agree to receive SMS messages from Project Healing Waters Colorado Alpine Program
            related to event invitations, RSVP reminders, and program updates. Message frequency
            varies. Message and data rates may apply. Reply STOP to opt out and HELP for help."
            The checkbox is not preselected and consent is not a condition of registration.
            Privacy Policy and Terms and Conditions links are displayed directly below the consent
            checkbox. Mobile information will not be sold or shared with third parties for promotional
            or marketing purposes.
          </p>

          <p>
            Keyword opt-in: Users can text START to +1 (970) 771-0150. The confirmation message is:
            "Project Healing Waters Alpine: You are subscribed to event notifications. Msg frequency
            varies. Msg&amp;data rates may apply. Reply HELP for help, STOP to opt out. Your mobile
            information will not be sold or shared with third parties for promotional or marketing
            purposes."
          </p>

          <p>
            Existing members can manage their notification preferences after signing in at{' '}
            <Link to="/preferences">Notification Preferences</Link>.
          </p>

          <div className="artifact-card">
            <div className="artifact-card__header">
              <h3>Live In-App Screenshot Path</h3>
              <span>Primary evidence should come from the signed-in Notification Preferences screen</span>
            </div>

            <p>
              Sign in, open <Link to="/preferences">Notification Preferences</Link>, check the SMS consent box,
              click Save preferences, and capture the resulting in-app screenshot.
            </p>

            <p>
              Backup static artifact URL (if a reviewer requests a direct public file):{' '}
              <a href={consentEnabledArtifactPath} target="_blank" rel="noreferrer">https://app.phwcoloradoalpine.org/images/sms-consent-actual.png</a>
            </p>

            <p>
              Explicit pre-consent screenshot (checkbox not preselected):{' '}
              <a href={consentArtifactPath} target="_blank" rel="noreferrer">https://app.phwcoloradoalpine.org/images/sms-consent.png</a>
            </p>

            <p>
              Standalone artifact page URL (no app shell):{' '}
              <a href={consentArtifactPagePath} target="_blank" rel="noreferrer">https://app.phwcoloradoalpine.org/compliance/sms-consent-artifact.html</a>
            </p>

            <img
              src={consentEnabledArtifactPath}
              alt="SMS consent screenshot showing user-enabled opt-in language and Save preferences action"
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