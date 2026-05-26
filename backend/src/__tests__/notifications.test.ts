import fs from 'node:fs';
import path from 'node:path';
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

  it('sendRsvpConfirmation does not CC coordinator (CC removed)', async () => {
    const emailSpy = jest.spyOn(notificationService, 'sendEmail').mockResolvedValue(undefined);

    sendRsvpConfirmation({
      eventId: '00000000-0000-0000-0000-000000000010',
      eventTitle: 'Casting Clinic',
      recipientEmail: 'member@example.com',
      eventLeadEmail: 'lead@example.com',
      firstName: 'Taylor',
      eventDate: '2026-07-12',
      rsvpStatus: 'yes',
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy).toHaveBeenCalledWith(expect.not.objectContaining({
      cc: expect.anything(),
    }));
  });

  it('sendRsvpConfirmation sends RSVP received (not confirmed) subject', async () => {
    const emailSpy = jest.spyOn(notificationService, 'sendEmail').mockResolvedValue(undefined);

    sendRsvpConfirmation({
      eventId: '00000000-0000-0000-0000-000000000011',
      eventTitle: 'Casting Clinic',
      recipientEmail: 'member@example.com',
      firstName: 'Taylor',
      eventDate: '2026-07-12',
      rsvpStatus: 'yes',
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(emailSpy).toHaveBeenCalledTimes(1);
    expect(emailSpy).toHaveBeenCalledWith(expect.objectContaining({
      subject: expect.stringContaining('RSVP Received'),
    }));
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

  it('sendSms does not truncate ordinary multi-segment messages', async () => {
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
    expect(smsArgs.message).toBe(longMessage);
    expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'sms',
      status: 'sent',
      providerId: 'provider-123',
      operationType: 'unit_test',
    }));
  });

  it('sendSms preserves URL when compacting extreme-length messages', async () => {
    const mockEmail = { sendEmail: jest.fn().mockResolvedValue(undefined) };
    const mockSms = { sendSms: jest.fn().mockResolvedValue('provider-124') };
    const service = new NotificationService(mockEmail, mockSms, true, true);

    const logSpy = jest
      .spyOn(service as unknown as { writeNotificationLog: (...args: unknown[]) => Promise<void> }, 'writeNotificationLog')
      .mockResolvedValue(undefined);

    const url = 'https://app.phwcoloradoalpine.org/rsvp/ZXlKaGJHY2lPaVeryLongTokenSegment1234567890';
    const exactLengthMessage = `${'B'.repeat(980)} RSVP: ${url} Reply STOP to opt out`;
    await service.sendSms({
      to: '+13035550003',
      message: exactLengthMessage,
      operationType: 'unit_test',
    });

    expect(mockSms.sendSms).toHaveBeenCalledTimes(1);
    const smsArgs = mockSms.sendSms.mock.calls[0][0] as { message: string };
    expect(smsArgs.message.length).toBeLessThanOrEqual(1000);
    const rsvpUrlMatch = smsArgs.message.match(/https:\/\/\S+/);
    expect(rsvpUrlMatch).not.toBeNull();
    const parsedActualUrl = new URL(rsvpUrlMatch![0]);
    const parsedExpectedUrl = new URL(url);
    expect(parsedActualUrl.origin).toBe(parsedExpectedUrl.origin);
    expect(parsedActualUrl.pathname).toBe(parsedExpectedUrl.pathname);
    expect(smsArgs.message.endsWith('Reply STOP to opt out')).toBe(true);
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

  it('keeps event lead exclusion in publish and reminder recipient SQL', () => {
    const sourcePath = path.resolve(__dirname, '../services/notifications.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');
    const leadExclusion = '(e.event_lead_member_id IS NULL OR m.member_id <> e.event_lead_member_id)';
    const occurrences = source.split(leadExclusion).length - 1;

    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('suppresses reminder recipients when another member on the same email already declined', () => {
    const sourcePath = path.resolve(__dirname, '../services/notifications.ts');
    const source = fs.readFileSync(sourcePath, 'utf8');

    expect(source).toContain("AND NOT EXISTS (");
    expect(source).toContain("er_email.response = 'no'");
    expect(source).toContain('LOWER(LTRIM(RTRIM(m_email.email))) = LOWER(LTRIM(RTRIM(m.email)))');
  });
});
