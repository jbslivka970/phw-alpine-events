import { Link } from 'react-router-dom'

function TermsPage() {
  return (
    <div className="legal-page">
      <div className="legal-page__shell">
        <div className="legal-page__crumbs">
          <Link to="/login">Back to sign in</Link>
        </div>

        <header className="legal-page__header">
          <p className="legal-page__eyebrow">Project Healing Waters Alpine Events</p>
          <h1 className="legal-page__title">Terms and Conditions</h1>
          <p className="legal-page__subtitle">
            These terms govern use of chapter event notifications and the SMS program
            operated by the Colorado Alpine Chapter.
          </p>
        </header>

        <section className="legal-section">
          <h2>Program Description</h2>
          <p>
            Project Healing Waters Colorado Alpine Chapter uses this platform to send
            event-related communications, including invitations, RSVP reminders, schedule
            updates, and day-of logistics for chapter programming.
          </p>
        </section>

        <section className="legal-section">
          <h2>SMS Consent</h2>
          <p>
            SMS messages are sent only to members who have provided explicit consent.
            Consent is collected through chapter-managed enrollment or profile update
            workflows.
          </p>
        </section>

        <section className="legal-section">
          <h2>Message Frequency and Charges</h2>
          <p>
            Message frequency varies based on chapter activity, member status, and event
            schedule. Message and data rates may apply depending on a member&apos;s mobile plan.
          </p>
        </section>

        <section className="legal-section">
          <h2>Opt-Out and Help</h2>
          <ul>
            <li>Reply STOP to unsubscribe from SMS messages</li>
            <li>Reply HELP for guidance on the messaging program</li>
            <li>Opting out of SMS does not remove a member from the chapter roster</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>Permitted Use</h2>
          <p>
            Members may use this service only for legitimate chapter participation.
            Unauthorized access, misuse of RSVP workflows, or attempts to interfere with
            chapter operations are prohibited.
          </p>
        </section>

        <section className="legal-section">
          <h2>Changes</h2>
          <p>
            The chapter may update these terms as operational, legal, or compliance
            requirements change. Updated terms will be posted at this URL.
          </p>
        </section>
      </div>
    </div>
  )
}

export { TermsPage }