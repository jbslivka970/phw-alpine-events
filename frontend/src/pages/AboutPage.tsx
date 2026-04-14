import { Link } from 'react-router-dom'

function AboutPage() {
  return (
    <div className="about-page">
      <div className="about-page__banner">
        A chapter of{' '}
        <a href="https://projecthealingwaters.org" target="_blank" rel="noopener noreferrer">
          Project Healing Waters Fly Fishing
        </a>
        , a national 501(c)(3) nonprofit (EIN 20-4391295)
      </div>

      <header className="about-page__header">
        <h1>Project Healing Waters<br />Colorado Alpine Program</h1>
        <p>
          Healing through camaraderie, connectedness, and fly fishing for Colorado mountain-community veterans
        </p>
      </header>

      <main className="about-page__main">
        <section>
          <h2>About Our Program</h2>
          <p>
            The Colorado Alpine Program is a chapter of Project Healing Waters Fly Fishing (PHWFF), a national 501(c)(3)
            nonprofit organization dedicated to the physical, emotional, and mental rehabilitation of active military
            service personnel and disabled veterans through fly fishing, fly tying, and rod building.
          </p>
          <p>
            Our chapter serves veterans across Colorado&apos;s mountain communities &mdash; including Summit County,
            Eagle County, Lake County, Grand County, Park County, Routt County, Garfield County, and Pitkin County
            &mdash; through guided fly fishing outings, skills clinics, and community events on Colorado&apos;s premier
            tailwater rivers and alpine lakes.
          </p>
          <p>
            The Colorado Alpine Program uses a custom events platform at{' '}
            <a href="https://app.phwcoloradoalpine.org">app.phwcoloradoalpine.org</a> to coordinate event invitations,
            RSVP management, logistics, and SMS notifications for registered members. All messaging is operational and
            informational &mdash; we do not send promotional or marketing messages.
          </p>
        </section>

        <section>
          <h2>Contact Information</h2>
          <div className="about-page__contact-grid">
            <div className="about-page__contact-item">
              <div className="about-page__label">Mailing Address</div>
              <div className="about-page__value">
                Project Healing Waters - Colorado Alpine<br />
                c/o Gravity Haus<br />
                605 S Park Avenue<br />
                Breckenridge, CO 80424
              </div>
            </div>
            <div className="about-page__contact-item">
              <div className="about-page__label">Phone</div>
              <div className="about-page__value"><a href="tel:+19707710150">+1 (970) 771-0150</a></div>
            </div>
            <div className="about-page__contact-item">
              <div className="about-page__label">Email</div>
              <div className="about-page__value"><a href="mailto:alpine@phwcoloradoalpine.org">alpine@phwcoloradoalpine.org</a></div>
            </div>
            <div className="about-page__contact-item">
              <div className="about-page__label">National Chapter Page</div>
              <div className="about-page__value"><a href="https://projecthealingwaters.org/location/colorado-alpine/" target="_blank" rel="noopener noreferrer">projecthealingwaters.org</a></div>
            </div>
          </div>
        </section>

        <section>
          <h2>Compliance &amp; Policies</h2>
          <p className="about-page__policy-links">
            <Link to="/privacy">Privacy Policy</Link>
            {' '}·{' '}
            <Link to="/terms">Terms &amp; Conditions</Link>
            {' '}·{' '}
            <Link to="/sms-program">SMS Program Details</Link>
          </p>
          <div className="about-page__affiliation">
            <strong>National Affiliation:</strong> Project Healing Waters Fly Fishing, Inc. is a 501(c)(3) tax-exempt
            organization (EIN 20-4391295) headquartered in LaPlata, MD. The Colorado Alpine Program operates as a
            volunteer-led local chapter under the national organization&apos;s mission and governance.
          </div>
        </section>
      </main>

      <footer className="about-page__footer">
        &copy; 2026 Project Healing Waters Colorado Alpine Program · <Link to="/privacy">Privacy</Link> ·{' '}
        <Link to="/terms">Terms</Link>
      </footer>
    </div>
  )
}

export { AboutPage }