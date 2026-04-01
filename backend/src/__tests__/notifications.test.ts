import {
  NotificationService,
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

  it('sendSms truncates messages longer than 160 characters', async () => {
    const mockEmail = { sendEmail: jest.fn().mockResolvedValue(undefined) };
    const mockSms = { sendSms: jest.fn().mockResolvedValue('provider-123') };
    const service = new NotificationService(mockEmail, mockSms, true, true);

    const logSpy = jest
      .spyOn(service as unknown as { writeNotificationLog: (...args: unknown[]) => Promise<void> }, 'writeNotificationLog')
      .mockResolvedValue(undefined);

    const longMessage = 'A'.repeat(220);
    await service.sendSms({
      to: '+13035550001',
      message: longMessage,
      operationType: 'unit_test',
    });

    expect(mockSms.sendSms).toHaveBeenCalledTimes(1);
    const smsArgs = mockSms.sendSms.mock.calls[0][0] as { message: string };
    expect(smsArgs.message.length).toBe(160);
    expect(smsArgs.message.endsWith('...')).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms',
      status: 'sent',
      providerId: 'provider-123',
      operationType: 'unit_test',
    }));
  });

  it('sendSms does not truncate a 160 character message', async () => {
    const mockEmail = { sendEmail: jest.fn().mockResolvedValue(undefined) };
    const mockSms = { sendSms: jest.fn().mockResolvedValue('provider-124') };
    const service = new NotificationService(mockEmail, mockSms, true, true);

    const logSpy = jest
      .spyOn(service as unknown as { writeNotificationLog: (...args: unknown[]) => Promise<void> }, 'writeNotificationLog')
      .mockResolvedValue(undefined);

    const exactLengthMessage = 'B'.repeat(160);
    await service.sendSms({
      to: '+13035550003',
      message: exactLengthMessage,
      operationType: 'unit_test',
    });

    expect(mockSms.sendSms).toHaveBeenCalledTimes(1);
    const smsArgs = mockSms.sendSms.mock.calls[0][0] as { message: string };
    expect(smsArgs.message).toBe(exactLengthMessage);
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms',
      status: 'sent',
      providerId: 'provider-124',
      operationType: 'unit_test',
    }));
  });

  it('sendSms logs skipped when member has not opted into SMS', async () => {
    const mockEmail = { sendEmail: jest.fn().mockResolvedValue(undefined) };
    const mockSms = { sendSms: jest.fn().mockResolvedValue('provider-456') };
    const service = new NotificationService(mockEmail, mockSms, true, true);

    jest
      .spyOn(service as unknown as { memberHasSmsOptIn: (memberId: string) => Promise<boolean> }, 'memberHasSmsOptIn')
      .mockResolvedValue(false);
    const logSpy = jest
      .spyOn(service as unknown as { writeNotificationLog: (...args: unknown[]) => Promise<void> }, 'writeNotificationLog')
      .mockResolvedValue(undefined);

    await service.sendSms({
      to: '+13035550002',
      message: 'Hello there',
      memberId: '00000000-0000-4000-8000-000000000001',
      operationType: 'unit_test',
    });

    expect(mockSms.sendSms).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms',
      status: 'skipped',
      operationType: 'unit_test',
    }));
  });

  it('sendEmail logs failed when provider send throws', async () => {
    const mockEmail = { sendEmail: jest.fn().mockRejectedValue(new Error('smtp down')) };
    const mockSms = { sendSms: jest.fn().mockResolvedValue(undefined) };
    const service = new NotificationService(mockEmail, mockSms, true, true);

    const logSpy = jest
      .spyOn(service as unknown as { writeNotificationLog: (...args: unknown[]) => Promise<void> }, 'writeNotificationLog')
      .mockResolvedValue(undefined);

    await service.sendEmail({
      to: 'member@example.com',
      subject: 'Subject',
      htmlBody: '<p>Hello</p>',
      operationType: 'unit_test',
    });

    expect(mockEmail.sendEmail).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'email',
      status: 'failed',
      operationType: 'unit_test',
      errorDetail: 'smtp down',
    }));
  });

  it('sendSms logs failed when provider send throws', async () => {
    const mockEmail = { sendEmail: jest.fn().mockResolvedValue(undefined) };
    const mockSms = { sendSms: jest.fn().mockRejectedValue(new Error('carrier down')) };
    const service = new NotificationService(mockEmail, mockSms, true, true);

    const logSpy = jest
      .spyOn(service as unknown as { writeNotificationLog: (...args: unknown[]) => Promise<void> }, 'writeNotificationLog')
      .mockResolvedValue(undefined);

    await service.sendSms({
      to: '+13035550004',
      message: 'Status update',
      operationType: 'unit_test',
    });

    expect(mockSms.sendSms).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms',
      status: 'failed',
      operationType: 'unit_test',
      errorDetail: 'carrier down',
    }));
  });
});
