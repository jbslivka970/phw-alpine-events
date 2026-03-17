/**
 * Notification stubs – real ACS sends are not implemented yet.
 * These functions log intent and return without sending anything.
 */

export interface NotificationPayload {
  eventId: string;
  eventTitle: string;
  recipientEmail?: string;
  recipientPhone?: string;
  subject?: string;
  body?: string;
}

export function sendEventPublishedNotification(payload: NotificationPayload): void {
  console.log('[STUB] sendEventPublishedNotification', payload);
}

export function sendRsvpConfirmation(payload: NotificationPayload): void {
  console.log('[STUB] sendRsvpConfirmation', payload);
}

export function sendEventCancelledNotification(payload: NotificationPayload): void {
  console.log('[STUB] sendEventCancelledNotification', payload);
}

export function sendEventReminderNotification(payload: NotificationPayload): void {
  console.log('[STUB] sendEventReminderNotification', payload);
}
