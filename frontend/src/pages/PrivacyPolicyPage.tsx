import { Link } from 'react-router-dom'

function PrivacyPolicyPage() {
  return (
    <div className="legal-page">
      <div className="legal-page__shell">
        <div className="legal-page__crumbs">
          <Link to="/login">Back to sign in</Link>
        </div>

        <header className="legal-page__header">
          <p className="legal-page__eyebrow">Project Healing Waters Alpine Events</p>
          <h1 className="legal-page__title">Privacy Policy</h1>
          <p className="legal-page__subtitle">
            This page describes how the Colorado Alpine Chapter uses member contact
            information for event operations, RSVP processing, and chapter communications.
          </p>
        </header>

        <section className="legal-section">
          <h2>Information We Collect</h2>
          <p>
            We collect member information needed to operate chapter events and outreach,
            including name, email address, mobile phone number, group membership, RSVP
            responses, attendance records, and communication consent status.
          </p>
        </section>

        <section className="legal-section">
          <h2>How We Use Information</h2>
          <ul>
            <li>To notify members about upcoming events and chapter activities</li>
            <li>To process RSVPs and maintain attendance records</li>
            <li>To send reminders related to events a member has joined or been invited to</li>
            <li>To track SMS consent and opt-out activity for compliance purposes</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>SMS Communications</h2>
          <p>
            Members who explicitly opt in may receive SMS messages related to event
            invitations, reminders, and logistics. Message frequency varies based on event
            activity. Message and data rates may apply. Members can opt out at any time by
            replying STOP.
          </p>
        </section>

        <section className="legal-section">
          <h2>Sharing of Information</h2>
          <p>
            Member contact information is used for chapter operations and is not sold to third
            parties. Service providers may process data only as needed to support application
            hosting, authentication, email delivery, SMS delivery, and database operations.
          </p>
        </section>

        <section className="legal-section">
          <h2>Data Retention</h2>
          <p>
            We retain member and event records for chapter administration, historical
            reporting, compliance logging, and operational continuity, subject to
            organizational needs and applicable legal requirements.
          </p>
        </section>

        <section className="legal-section">
          <h2>Your Choices</h2>
          <ul>
            <li>You may opt out of SMS at any time by replying STOP</li>
            <li>You may request updates to your contact information through chapter leadership</li>
            <li>You may opt out of email where applicable through chapter communication preferences</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>Contact</h2>
          <p>
            For questions about privacy or communication preferences, contact the Colorado
            Alpine Chapter administrator using the chapter contact information provided during
            onboarding.
          </p>
        </section>
      </div>
    </div>
  )
}

export { PrivacyPolicyPage }