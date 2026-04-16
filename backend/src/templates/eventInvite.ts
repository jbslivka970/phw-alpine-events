import { NotificationTemplate } from './NotificationTemplate';

const eventInviteTemplate: NotificationTemplate = {
  templateId: 'event-invite',
  displayName: 'Event Invite',
  channel: 'both',
  subjectTemplate: '🎣 {{eventTitle}} — {{eventDate}}',
  htmlBodyTemplate: `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f7f3;padding:22px 10px;font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;width:100%;background:#ffffff;border:1px solid #d4ddd5;border-radius:18px;overflow:hidden;box-shadow:0 10px 28px rgba(25,43,34,0.08);">
            <tr>
              <td style="padding:22px 22px 20px;background:linear-gradient(132deg,#2d5f4d,#1f4a3a);color:#ffffff;">
                <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;opacity:0.88;">Colorado Alpine Events</p>
                <h2 style="margin:0;font-size:34px;line-height:1.12;letter-spacing:-0.02em;">You're Invited</h2>
                <p style="margin:10px 0 0;font-size:15px;opacity:0.95;line-height:1.4;">A meaningful day on the water with PHW Alpine.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 18px 10px;">
                {{photoSection}}
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #d4ddd5;border-radius:14px;background:#f7fbf8;">
                  <tr><td style="padding:14px 15px 3px;"><strong style="color:#1f4a3a;">Event:</strong> {{eventTitle}}</td></tr>
                  <tr><td style="padding:3px 15px;"><strong style="color:#1f4a3a;">Date and Time:</strong> {{eventDate}}</td></tr>
                  <tr><td style="padding:3px 15px 14px;"><strong style="color:#1f4a3a;">Location:</strong> {{location}}{{mapSection}}</td></tr>
                </table>
                {{eventLeadSection}}
                <div style="margin:16px 0 0;padding:16px 16px;border-left:4px solid #c46a28;background:#fff8f1;border-radius:0 12px 12px 0;white-space:pre-wrap;line-height:1.5;">{{description}}</div>
                <p style="margin:20px 0 8px;font-weight:800;color:#1f4a3a;letter-spacing:0.01em;">RSVP Options</p>
                <p style="margin:0 0 12px;color:#40574d;font-size:14px;">Choose an option below to record your RSVP instantly.</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
                  <tr>
                    <td style="padding:0 8px 8px 0;"><a href="{{yesUrl}}" style="display:inline-block;padding:11px 16px;border-radius:999px;background:#2d5f4d;color:#ffffff;text-decoration:none;font-weight:700;">Yes</a></td>
                    <td style="padding:0 8px 8px 0;"><a href="{{noUrl}}" style="display:inline-block;padding:11px 16px;border-radius:999px;background:#b32722;color:#ffffff;text-decoration:none;font-weight:700;">No</a></td>
                    <td style="padding:0 8px 8px 0;"><a href="{{maybeUrl}}" style="display:inline-block;padding:11px 16px;border-radius:999px;background:#c46a28;color:#ffffff;text-decoration:none;font-weight:700;">Maybe</a></td>
                    <td style="padding:0 0 8px 0;"><a href="{{waitlistUrl}}" style="display:inline-block;padding:11px 16px;border-radius:999px;background:#354b5d;color:#ffffff;text-decoration:none;font-weight:700;">Waitlist</a></td>
                  </tr>
                </table>
                <p style="margin:0 0 8px;color:#41584f;font-size:14px;"><strong>Prefer email reply?</strong> These links open a prefilled email:</p>
                <p style="margin:0 0 16px;line-height:1.9;">
                  <a href="{{replyYesMailto}}" style="display:inline-block;color:#2d5f4d;text-decoration:underline;font-weight:600;margin-right:10px;">Reply YES</a>
                  <span style="color:#91a59b;margin-right:10px;">|</span>
                  <a href="{{replyNoMailto}}" style="display:inline-block;color:#2d5f4d;text-decoration:underline;font-weight:600;margin-right:10px;">Reply NO</a>
                  <span style="color:#91a59b;margin-right:10px;">|</span>
                  <a href="{{replyMaybeMailto}}" style="display:inline-block;color:#2d5f4d;text-decoration:underline;font-weight:600;margin-right:10px;">Reply MAYBE</a>
                  <span style="color:#91a59b;margin-right:10px;">|</span>
                  <a href="{{replyWaitlistMailto}}" style="display:inline-block;color:#2d5f4d;text-decoration:underline;font-weight:600;">Reply WAITLIST</a>
                </p>
                <p style="margin:0 0 12px;"><a href="{{rsvpUrl}}" style="color:#1f4a3a;text-decoration:underline;font-weight:800;">Open the full RSVP page</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:15px 16px;border-top:1px solid #e2e9e3;background:#f8faf8;">
                <p style="margin:0 0 6px;font-weight:800;color:#1f4a3a;">Project Healing Waters Fly Fishing - Colorado Alpine Program</p>
                <p style="margin:0;font-size:12px;color:#61756b;">You are receiving this message because you are part of PHW Alpine communications.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `,
  textBodyTemplate:
    'You\'re invited to {{eventTitle}}.\n\nDate and time: {{eventDate}}\nLocation: {{location}}\nMap: {{mapUrl}}\n\n{{description}}\n\nRSVP options:\nYes: {{yesUrl}}\nNo: {{noUrl}}\nMaybe: {{maybeUrl}}\nWaitlist: {{waitlistUrl}}\n\nPrefer email reply?\nReply YES: {{replyYesMailto}}\nReply NO: {{replyNoMailto}}\nReply MAYBE: {{replyMaybeMailto}}\nReply WAITLIST: {{replyWaitlistMailto}}\n\nFull RSVP page: {{rsvpUrl}}\n\nProject Healing Waters Fly Fishing - Colorado Alpine Program',
  smsBodyTemplate:
    'PHW Alpine: {{eventTitle}} on {{eventDate}} at {{location}}. RSVP: {{rsvpUrl}} Reply STOP to opt out',
  variables: [
    { name: 'eventTitle', description: 'Event title', required: true },
    { name: 'eventDate', description: 'Formatted event date', required: true },
    { name: 'location', description: 'Event location', required: true },
    { name: 'description', description: 'Event description', required: true },
    { name: 'mapUrl', description: 'Google Maps URL for event location', required: false },
    { name: 'mapSection', description: 'Rendered map link section for HTML emails', required: false },
    { name: 'photoSection', description: 'Rendered event photo section for HTML emails', required: false },
    { name: 'eventLeadName', description: 'Event coordinator name', required: false },
    { name: 'eventLeadEmail', description: 'Event coordinator email', required: false },
    { name: 'eventLeadSection', description: 'Rendered coordinator section for HTML emails', required: false },
    { name: 'rsvpUrl', description: 'RSVP URL', required: true },
    { name: 'yesUrl', description: 'One-click yes RSVP URL', required: true },
    { name: 'noUrl', description: 'One-click no RSVP URL', required: true },
    { name: 'maybeUrl', description: 'One-click maybe RSVP URL', required: true },
    { name: 'waitlistUrl', description: 'One-click waitlist RSVP URL', required: true },
    { name: 'replyYesMailto', description: 'Prefilled reply-by-email URL for yes', required: true },
    { name: 'replyNoMailto', description: 'Prefilled reply-by-email URL for no', required: true },
    { name: 'replyMaybeMailto', description: 'Prefilled reply-by-email URL for maybe', required: true },
    { name: 'replyWaitlistMailto', description: 'Prefilled reply-by-email URL for waitlist', required: true },
  ],
};

export { eventInviteTemplate };
