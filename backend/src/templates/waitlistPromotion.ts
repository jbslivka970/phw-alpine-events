import { NotificationTemplate } from './NotificationTemplate';

const waitlistPromotionTemplate: NotificationTemplate = {
  templateId: 'waitlist-promotion',
  displayName: 'Waitlist Promotion',
  channel: 'both',
  subjectTemplate: '[WAITLIST OPENING] {{eventTitle}} - Confirm by {{expiresAt}}',
  htmlBodyTemplate: `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#1f2937;max-width:640px;margin:0 auto;">
      <p>Hey PHW Colorado Alpine Family,</p>
      <p>A spot just opened for <strong>{{eventTitle}}</strong> on <strong>{{eventDate}}</strong>.</p>
      <p>Please confirm your RSVP by <strong>{{expiresAt}}</strong> to keep this spot.</p>
      <p style="margin:16px 0 8px;"><strong>Respond now:</strong></p>
      <p style="margin:0 0 16px;display:flex;flex-wrap:wrap;gap:8px;">
        <a href="{{yesUrl}}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#155724;color:#ffffff;text-decoration:none;">Claim Spot</a>
        <a href="{{noUrl}}" style="display:inline-block;padding:10px 14px;border-radius:999px;background:#721c24;color:#ffffff;text-decoration:none;">Pass</a>
      </p>
      <p>If we do not hear back by the deadline, we will offer the spot to the next person on the waitlist.</p>
      <p style="margin-top:20px;">Project Healing Waters Fly Fishing - Colorado Alpine Chapter</p>
    </div>
  `,
  textBodyTemplate:
    'PHW Alpine: A spot opened for {{eventTitle}} on {{eventDate}}. Confirm by {{expiresAt}} to claim it. Yes: {{yesUrl}} No: {{noUrl}}',
  smsBodyTemplate:
    'PHW Alpine: spot open for {{eventTitle}}. Reply YES by {{expiresAt}} to claim, or NO to pass. {{rsvpUrl}}',
  variables: [
    { name: 'eventTitle', description: 'Event title', required: true },
    { name: 'eventDate', description: 'Formatted event date', required: true },
    { name: 'expiresAt', description: 'Offer expiry date/time', required: true },
    { name: 'rsvpUrl', description: 'RSVP landing URL', required: true },
    { name: 'yesUrl', description: 'One-click yes URL', required: true },
    { name: 'noUrl', description: 'One-click no URL', required: true },
  ],
};

export { waitlistPromotionTemplate };