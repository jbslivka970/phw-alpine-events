import { NotificationTemplate } from './NotificationTemplate';

const eventInviteTemplate: NotificationTemplate = {
  templateId: 'event-invite',
  displayName: 'Event Invite',
  channel: 'both',
  subjectTemplate: '🎣 {{eventTitle}} — {{eventDate}}',
  htmlBodyTemplate: `
    <div style="font-family:'Segoe UI',Arial,sans-serif;line-height:1.6;color:#1f2937;max-width:640px;margin:0 auto;background:#ffffff;">
      <h2 style="margin:0 0 12px;font-size:22px;color:#0f172a;">You're Invited</h2>
      <p style="margin:0 0 12px;">Hey PHW Colorado Alpine Family,</p>
      <p style="margin:0 0 16px;">We're excited to have you join this upcoming event:</p>
      <div style="border:1px solid #dbe3ee;border-radius:12px;padding:14px 16px;background:#f8fbff;">
        <p style="margin:0 0 8px 0;"><strong>Event:</strong> {{eventTitle}}</p>
        <p style="margin:0 0 8px 0;"><strong>Date and Time:</strong> {{eventDate}}</p>
        <p style="margin:0;"><strong>Location:</strong> {{location}}</p>
      </div>
      <p style="margin:16px 0 0;">{{description}}</p>
      <p style="margin:18px 0 8px;"><strong>RSVP Options</strong></p>
      <p style="margin:0 0 12px;color:#475569;font-size:14px;">Select an option below to record your RSVP instantly for your member profile.</p>
      <p style="margin:0 0 16px;display:flex;flex-wrap:wrap;gap:8px;">
        <a href="{{yesUrl}}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#166534;color:#ffffff;text-decoration:none;font-weight:600;">Yes</a>
        <a href="{{noUrl}}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#991b1b;color:#ffffff;text-decoration:none;font-weight:600;">No</a>
        <a href="{{maybeUrl}}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#92400e;color:#ffffff;text-decoration:none;font-weight:600;">Maybe</a>
        <a href="{{waitlistUrl}}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#334155;color:#ffffff;text-decoration:none;font-weight:600;">Waitlist</a>
      </p>
      <p style="margin:0 0 6px;color:#334155;font-size:14px;"><strong>Prefer email reply?</strong> These links open a prefilled email:</p>
      <p style="margin:0 0 16px;display:flex;flex-wrap:wrap;gap:8px;">
        <a href="{{replyYesMailto}}" style="color:#1d4ed8;text-decoration:underline;">Reply YES</a>
        <a href="{{replyNoMailto}}" style="color:#1d4ed8;text-decoration:underline;">Reply NO</a>
        <a href="{{replyMaybeMailto}}" style="color:#1d4ed8;text-decoration:underline;">Reply MAYBE</a>
        <a href="{{replyWaitlistMailto}}" style="color:#1d4ed8;text-decoration:underline;">Reply WAITLIST</a>
      </p>
      <p style="margin:0 0 16px;"><a href="{{rsvpUrl}}" style="color:#1d4ed8;text-decoration:underline;">Open the full RSVP page</a></p>
      <hr style="border:none;border-top:1px solid #e2e8f0;margin:18px 0 12px;" />
      <p style="margin:0 0 8px;font-weight:600;">Project Healing Waters Fly Fishing - Colorado Alpine Chapter</p>
      <p style="margin:0;font-size:12px;color:#64748b;">You are receiving this message because you are part of PHW Alpine communications.</p>
    </div>
  `,
  textBodyTemplate:
    'Hey PHW Colorado Alpine Family,\n\nYou are invited to {{eventTitle}}.\nWhen: {{eventDate}}\nWhere: {{location}}\n\n{{description}}\n\nOne-click RSVP options:\nYes: {{yesUrl}}\nNo: {{noUrl}}\nMaybe: {{maybeUrl}}\nWaitlist: {{waitlistUrl}}\n\nEmail reply links:\nReply YES: {{replyYesMailto}}\nReply NO: {{replyNoMailto}}\nReply MAYBE: {{replyMaybeMailto}}\nReply WAITLIST: {{replyWaitlistMailto}}\n\nFull RSVP page: {{rsvpUrl}}\n\nProject Healing Waters Fly Fishing - Colorado Alpine Chapter',
  smsBodyTemplate:
    'PHW Alpine: {{eventTitle}} on {{eventDate}} at {{location}}. RSVP: {{rsvpUrl}} Reply STOP to opt out',
  variables: [
    { name: 'eventTitle', description: 'Event title', required: true },
    { name: 'eventDate', description: 'Formatted event date', required: true },
    { name: 'location', description: 'Event location', required: true },
    { name: 'description', description: 'Event description', required: true },
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
