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
            Effective Date: April 8, 2026
          </p>
        </header>

        <section className="legal-section">
          <p>
            Project Healing Waters Fly Fishing, Inc. (PHWFF), including the Colorado Alpine
            Program, is committed to protecting your privacy. This Privacy Policy explains how
            we collect, use, and safeguard your information when you use the PHW Colorado Alpine
            Events application at https://app.phwcoloradoalpine.org and our related SMS
            messaging services.
          </p>
          <p>
            This policy supplements the PHWFF National Privacy Policy. In the event of any
            conflict regarding the Colorado Alpine Program services, this policy controls.
          </p>
        </section>

        <section className="legal-section">
          <h2>Information We Collect</h2>
          <h3>Information You Provide</h3>
          <ul>
            <li>Account information: name, email address, and mobile phone number</li>
            <li>Event participation data: RSVPs, waitlist preferences, and attendance history</li>
          </ul>

          <h3>Information Collected Automatically</h3>
          <ul>
            <li>IP address, device type, operating system, and browser type</li>
            <li>Usage data such as pages visited and actions taken within the App</li>
          </ul>

          <h3>Information Related to SMS Messaging</h3>
          <ul>
            <li>Mobile phone number provided for SMS opt-in</li>
            <li>SMS opt-in and opt-out status and timestamps</li>
            <li>Message delivery and response data</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>SMS/Text Messaging Program</h2>
          <h3>Program Description</h3>
          <p>
            The PHW Colorado Alpine Events SMS program sends operational text messages to
            opted-in members, including event invitations, event reminders, RSVP confirmations,
            waitlist updates, and member support messages.
          </p>

          <h3>Opt-In</h3>
          <p>You may opt in to receive SMS messages by:</p>
          <ol>
            <li>Providing your mobile phone number and checking consent in the app</li>
            <li>Texting START or YES to +1 (970) 771-0150</li>
          </ol>
          <p>
            By opting in, you consent to receive recurring automated SMS messages from Project
            Healing Waters Alpine Events. Consent is not a condition of participation in any
            PHWFF program or event.
          </p>

          <h3>Message Frequency</h3>
          <p>
            Message frequency varies based on event activity. You may receive multiple messages
            per week during active event periods and fewer messages during off-season.
          </p>

          <h3>Message and Data Rates</h3>
          <p>Message and data rates may apply. Check with your mobile carrier for details.</p>

          <h3>Opt-Out</h3>
          <p>
            You may opt out at any time by replying STOP, UNSUBSCRIBE, CANCEL, END, or QUIT.
            After opting out, you will receive a single confirmation message and no further SMS
            messages unless you re-subscribe.
          </p>

          <h3>Help</h3>
          <p>
            For help, reply HELP to any message, visit <Link to="/privacy">this privacy policy page</Link>,
            or contact us using the information below.
          </p>

          <h3>No Third-Party Sharing for Marketing</h3>
          <p>
            We do not sell, rent, share, or disclose your mobile phone number or SMS opt-in
            data to any third parties for their marketing or promotional purposes.
          </p>

          <h3>Supported Carriers</h3>
          <p>Major U.S. carriers are supported. Carriers are not liable for delayed or undelivered messages.</p>
        </section>

        <section className="legal-section">
          <h2>How We Use Your Information</h2>
          <ul>
            <li>To send SMS notifications related to PHW Colorado Alpine events</li>
            <li>To manage event RSVPs, waitlist status, and attendance</li>
            <li>To provide member support and respond to inquiries</li>
            <li>To improve the App and event coordination services</li>
            <li>To comply with legal requirements and enforce terms</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>Data Security</h2>
          <p>
            We implement reasonable administrative, technical, and organizational security
            measures to protect your personal information from unauthorized access,
            disclosure, alteration, and destruction.
          </p>
        </section>

        <section className="legal-section">
          <h2>Third-Party Services</h2>
          <p>
            We use service providers to operate the app and SMS program, including Telnyx for
            SMS delivery and Microsoft Azure for hosting and data storage.
          </p>
          <p>We do not sell your personal data to any third party.</p>
        </section>

        <section className="legal-section">
          <h2>Your Rights</h2>
          <ul>
            <li>You may request access to, correction of, or deletion of your personal data</li>
            <li>You may opt out of SMS messages at any time by replying STOP</li>
            <li>You may opt out of email communications using the unsubscribe link in any email</li>
          </ul>
        </section>

        <section className="legal-section">
          <h2>Children&apos;s Privacy</h2>
          <p>We do not knowingly collect personal information from individuals under the age of 13.</p>
        </section>

        <section className="legal-section">
          <h2>Changes to This Policy</h2>
          <p>
            We may update this policy from time to time. Changes will be posted at
            https://app.phwcoloradoalpine.org/privacy with an updated effective date.
          </p>
        </section>

        <section className="legal-section">
          <h2>Contact Us</h2>
          <p>
            For questions about this Privacy Policy or the SMS messaging program, contact:
          </p>
          <ul>
            <li>Email: support@phwcoloradoalpine.org</li>
            <li>Web: https://app.phwcoloradoalpine.org</li>
            <li>National Organization: https://projecthealingwaters.org</li>
          </ul>
        </section>
      </div>
    </div>
  )
}

export { PrivacyPolicyPage }