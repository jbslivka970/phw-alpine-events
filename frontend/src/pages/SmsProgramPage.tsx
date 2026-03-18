import { Link } from 'react-router-dom'

function SmsProgramPage() {
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
            Project Healing Waters Colorado Alpine Chapter sends informational SMS messages to
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
              <span>Use this layout as verification support</span>
            </div>

            <div className="consent-demo">
              <label className="consent-demo__field">
                <span>Mobile phone number</span>
                <input type="text" value="(970) 555-0123" readOnly />
              </label>

              <label className="consent-demo__checkbox">
                <input type="checkbox" checked readOnly />
                <span>
                  I agree to receive SMS messages from Project Healing Waters Colorado Alpine
                  Chapter related to event invitations, RSVP reminders, and program updates.
                  Message frequency varies. Message and data rates may apply. Reply STOP to
                  opt out and HELP for help.
                </span>
              </label>

              <p className="consent-demo__links">
                See our <Link to="/privacy">Privacy Policy</Link> and{' '}
                <Link to="/terms">Terms and Conditions</Link>.
              </p>

              <button className="btn btn--primary" type="button">Save preferences</button>
            </div>
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
                Chapter leadership. Reply STOP to opt out. See Terms and Privacy pages for
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