import {
  notificationService,
  sendRsvpConfirmation,
} from '../services/notifications';

describe('notifications service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sendRsvpConfirmation sends email when recipientEmail is provided', async () => {
    const emailSpy = jest.spyOn(notificationService, 'sendEmail').mockResolvedValue(undefined);
    const smsSpy = jest.spyOn(notificationService, 'sendSms').mockResolvedValue(undefined);

    sendRsvpConfirmation({
      eventId: '00000000-0000-0000-0000-000000000001',
      eventTitle: 'Casting Clinic',
      recipientEmail: 'member@example.com',
      firstName: 'Taylor',
      eventDate: '2026-07-12',
      rsvpStatus: 'yes',
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(smsSpy).not.toHaveBeenCalled();
  });

  it('sendRsvpConfirmation sends SMS when recipientPhone is provided', async () => {
    const emailSpy = jest.spyOn(notificationService, 'sendEmail').mockResolvedValue(undefined);
    const smsSpy = jest.spyOn(notificationService, 'sendSms').mockResolvedValue(undefined);

    sendRsvpConfirmation({
      eventId: '00000000-0000-0000-0000-000000000002',
      eventTitle: 'River Day',
      recipientPhone: '+13035551212',
      firstName: 'Riley',
      eventDate: '2026-07-15',
      rsvpStatus: 'yes',
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(smsSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy).not.toHaveBeenCalled();
  });
});
