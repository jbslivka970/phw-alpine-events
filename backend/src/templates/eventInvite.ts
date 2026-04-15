import { NotificationTemplate } from './NotificationTemplate';

const eventInviteTemplate: NotificationTemplate = {
  templateId: 'event-invite',
  displayName: 'Event Invite',
  channel: 'both',
  subjectTemplate: '🎣 {{eventTitle}} — {{eventDate}}',
  htmlBodyTemplate: `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#eef4fb;padding:18px 8px;font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;width:100%;background:#ffffff;border:1px solid #d9e4f5;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:18px 20px;background:linear-gradient(120deg,#1f4f85,#2a6a86);color:#ffffff;">
                <p style="margin:0 0 6px;font-size:13px;letter-spacing:0.4px;text-transform:uppercase;opacity:0.9;">Project Healing Waters - Colorado Alpine</p>
                <h2 style="margin:0;font-size:28px;line-height:1.2;">You're Invited</h2>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 16px 8px;">
                {{photoSection}}
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #d9e4f5;border-radius:12px;background:#f8fbff;">
                  <tr><td style="padding:14px 14px 2px;"><strong style="color:#12386b;">Event:</strong> {{eventTitle}}</td></tr>
                  <tr><td style="padding:2px 14px;"><strong style="color:#12386b;">Date and Time:</strong> {{eventDate}}</td></tr>
                  <tr><td style="padding:2px 14px 14px;"><strong style="color:#12386b;">Location:</strong> {{location}}{{mapSection}}</td></tr>
                </table>
                {{eventLeadSection}}
                <div style="margin:14px 0 0;padding:14px 14px;border-left:4px solid #2f6f90;background:#f5f9ff;white-space:pre-wrap;">{{description}}</div>
                <p style="margin:18px 0 8px;font-weight:700;color:#0f2f5e;">RSVP Options</p>
                <p style="margin:0 0 12px;color:#455a78;font-size:14px;">Select an option below to record your RSVP instantly for your member profile.</p>
                <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;">
                  <tr>
                    <td style="padding:0 8px 8px 0;"><a href="{{yesUrl}}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#166534;color:#ffffff;text-decoration:none;font-weight:700;">Yes</a></td>
                    <td style="padding:0 8px 8px 0;"><a href="{{noUrl}}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#991b1b;color:#ffffff;text-decoration:none;font-weight:700;">No</a></td>
                    <td style="padding:0 8px 8px 0;"><a href="{{maybeUrl}}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#92400e;color:#ffffff;text-decoration:none;font-weight:700;">Maybe</a></td>
                    <td style="padding:0 0 8px 0;"><a href="{{waitlistUrl}}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#334155;color:#ffffff;text-decoration:none;font-weight:700;">Waitlist</a></td>
                  </tr>
                </table>
                <p style="margin:0 0 8px;color:#334155;font-size:14px;"><strong>Prefer email reply?</strong> These links open a prefilled email:</p>
                <p style="margin:0 0 16px;line-height:1.9;">
                  <a href="{{replyYesMailto}}" style="display:inline-block;color:#1456cc;text-decoration:underline;margin-right:10px;">Reply YES</a>
                  <span style="color:#90a1b5;margin-right:10px;">|</span>
                  <a href="{{replyNoMailto}}" style="display:inline-block;color:#1456cc;text-decoration:underline;margin-right:10px;">Reply NO</a>
                  <span style="color:#90a1b5;margin-right:10px;">|</span>
                  <a href="{{replyMaybeMailto}}" style="display:inline-block;color:#1456cc;text-decoration:underline;margin-right:10px;">Reply MAYBE</a>
                  <span style="color:#90a1b5;margin-right:10px;">|</span>
                  <a href="{{replyWaitlistMailto}}" style="display:inline-block;color:#1456cc;text-decoration:underline;">Reply WAITLIST</a>
                </p>
                <p style="margin:0 0 12px;"><a href="{{rsvpUrl}}" style="color:#1456cc;text-decoration:underline;font-weight:600;">Open the full RSVP page</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:14px 16px;border-top:1px solid #e3ecf7;background:#f9fbff;">
                <p style="margin:0 0 6px;font-weight:700;color:#12386b;">Project Healing Waters Fly Fishing - Colorado Alpine Program</p>
                <p style="margin:0;font-size:12px;color:#64748b;">You are receiving this message because you are part of PHW Alpine communications.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `,
  textBodyTemplate:
    'Hey PHW Colorado Alpine Family,\n\nYou are invited to {{eventTitle}}.\nWhen: {{eventDate}}\nWhere: {{location}}\nMap: {{mapUrl}}\n\n{{description}}\n\nOne-click RSVP options:\nYes: {{yesUrl}}\nNo: {{noUrl}}\nMaybe: {{maybeUrl}}\nWaitlist: {{waitlistUrl}}\n\nEmail reply links:\nReply YES: {{replyYesMailto}}\nReply NO: {{replyNoMailto}}\nReply MAYBE: {{replyMaybeMailto}}\nReply WAITLIST: {{replyWaitlistMailto}}\n\nFull RSVP page: {{rsvpUrl}}\n\nProject Healing Waters Fly Fishing - Colorado Alpine Program',
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
