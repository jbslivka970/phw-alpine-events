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
            Effective Date: April 8, 2026
          </p>
        </header>

        <section className="legal-section">
          <h2>Use of the App</h2>
          <p>
            These Terms and Conditions govern your use of the PHW Colorado Alpine Events
            application at https://app.phwcoloradoalpine.org and the related SMS messaging
            service operated by the Colorado Alpine Program of Project Healing Waters Fly
            Fishing, Inc.
          </p>
          <p>
            The App is provided to facilitate event coordination for the PHW Colorado Alpine
            Program, including event invitations, RSVPs, reminders, waitlist management, and
            member communications. Use of the App is available to eligible PHWFF participants,
            volunteers, and program staff.
          </p>
          <p>
            You agree to provide accurate information and to keep your contact information current.
          </p>
        </section>

        <section className="legal-section">
          <h2>SMS Messaging Terms</h2>
          <h3>Consent</h3>
          <p>
            By providing your mobile phone number and opting in through the App or by texting
            START to +1 (970) 771-0150, you consent to receive recurring automated SMS messages
            from Project Healing Waters Alpine Events. These messages include event invitations,
            reminders, RSVP confirmations, waitlist updates, and support messages.
          </p>
          <p>
            Consent is not required as a condition of participation in any PHWFF program,
            event, or service.
          </p>

          <h3>Message Frequency</h3>
          <p>Message frequency varies based on event activity.</p>

          <h3>Costs</h3>
          <p>Message and data rates may apply. You are responsible for any fees charged by your mobile carrier.</p>

          <h3>Opt-Out</h3>
          <p>
            Reply STOP to any message to opt out. You may also reply UNSUBSCRIBE, CANCEL, END,
            or QUIT. You will receive a single confirmation message after opting out.
          </p>

          <h3>Help</h3>
          <p>Reply HELP to any message for assistance, or visit https://app.phwcoloradoalpine.org/privacy.</p>

          <h3>No Third-Party Sharing</h3>
          <p>
            We will not sell or share your phone number or opt-in information with third parties
            for marketing purposes.
          </p>

          <h3>Carrier Disclaimer</h3>
          <p>Carriers are not liable for delayed or undelivered messages. Service availability may vary by carrier.</p>
        </section>

        <section className="legal-section">
          <h2>Intellectual Property</h2>
          <p>
            All content, branding, and materials in the App are the property of Project Healing
            Waters Fly Fishing, Inc. and are used under authorization by the Colorado Alpine Program.
          </p>
        </section>

        <section className="legal-section">
          <h2>Disclaimer of Warranties</h2>
          <p>The App and SMS service are provided as is without warranties of any kind, express or implied.</p>
        </section>

        <section className="legal-section">
          <h2>Limitation of Liability</h2>
          <p>
            To the fullest extent permitted by law, PHWFF and the Colorado Alpine Program shall
            not be liable for any indirect, incidental, or consequential damages arising from
            your use of the App or SMS service.
          </p>
        </section>

        <section className="legal-section">
          <h2>Changes to These Terms</h2>
          <p>
            We may update these Terms at any time. Changes will be posted at
            https://app.phwcoloradoalpine.org/terms with an updated effective date.
          </p>
        </section>

        <section className="legal-section">
          <h2>Contact Us</h2>
          <ul>
            <li>Email: support@phwcoloradoalpine.org</li>
            <li>Web: https://app.phwcoloradoalpine.org</li>
            <li>Privacy Policy: https://app.phwcoloradoalpine.org/privacy</li>
          </ul>
        </section>
      </div>
    </div>
  )
}

export { TermsPage }