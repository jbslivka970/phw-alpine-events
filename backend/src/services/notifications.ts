interface NotificationPayload {
  eventId: string;
  eventTitle: string;
  recipientEmail?: string;
  recipientPhone?: string;
}

function sendEventPublishedNotification(payload: NotificationPayload): void {
  console.log('[STUB] sendEventPublishedNotification', payload);
}

function sendEventCancelledNotification(payload: NotificationPayload): void {
  console.log('[STUB] sendEventCancelledNotification', payload);
}

function sendRsvpConfirmation(payload: NotificationPayload): void {
  console.log('[STUB] sendRsvpConfirmation', payload);
}

export {
  sendEventCancelledNotification,
  sendEventPublishedNotification,
  sendRsvpConfirmation,
};
export type { NotificationPayload };