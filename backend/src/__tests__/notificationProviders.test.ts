import { EmailClient } from '@azure/communication-email';
import { SmsClient } from '@azure/communication-sms';
import twilio from 'twilio';
import { AcsEmailService, AcsSmsService, TwilioSmsService } from '../services/notifications';

const emailBeginSendMock = jest.fn();
const smsSendMock = jest.fn();
const twilioMessagesCreateMock = jest.fn();

jest.mock('@azure/communication-email', () => ({
  EmailClient: jest.fn().mockImplementation(() => ({
    beginSend: emailBeginSendMock,
  })),
}));

jest.mock('@azure/communication-sms', () => ({
  SmsClient: jest.fn().mockImplementation(() => ({
    send: smsSendMock,
  })),
}));

jest.mock('twilio', () =>
  jest.fn().mockImplementation(() => ({
    messages: {
      create: twilioMessagesCreateMock,
    },
  }))
);

describe('ACS notification providers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('AcsEmailService sends with To-line + recipient BCC and returns provider id', async () => {
    const pollUntilDone = jest.fn().mockResolvedValue({ id: 'email-provider-id', status: 'Succeeded' });
    emailBeginSendMock.mockResolvedValue({ pollUntilDone });

    const service = new AcsEmailService('endpoint=sb://test;', 'noreply@example.org', ['region-admin@example.org']);

    const providerId = await service.sendEmail({
      to: 'member@example.org',
      subject: 'Event Invite',
      htmlBody: '<p>Hello</p>',
      textBody: 'Hello',
    });

    expect(EmailClient).toHaveBeenCalledWith('endpoint=sb://test;');
    expect(emailBeginSendMock).toHaveBeenCalledWith(
      expect.objectContaining({
        senderAddress: 'noreply@example.org',
        recipients: {
          to: [{ address: 'region-admin@example.org' }],
          bcc: [{ address: 'member@example.org' }],
        },
      })
    );
    expect(providerId).toBe('email-provider-id');
  });

  it('AcsEmailService throws when ACS reports failed status', async () => {
    const pollUntilDone = jest.fn().mockResolvedValue({ status: 'failed', error: { code: 'BadRequest' } });
    emailBeginSendMock.mockResolvedValue({ pollUntilDone });

    const service = new AcsEmailService('endpoint=sb://test;', 'noreply@example.org', ['region-admin@example.org']);

    await expect(
      service.sendEmail({
        to: 'member@example.org',
        subject: 'Event Invite',
        htmlBody: '<p>Hello</p>',
      })
    ).rejects.toThrow('ACS email send failed');
  });

  it('AcsSmsService returns message id for successful recipient', async () => {
    smsSendMock.mockResolvedValue({ value: [{ successful: true, messageId: 'sms-provider-id' }] });

    const service = new AcsSmsService('endpoint=sb://test;', '+13035550000');

    const providerId = await service.sendSms({
      to: '+13035551111',
      message: 'Reminder text',
    });

    expect(SmsClient).toHaveBeenCalledWith('endpoint=sb://test;');
    expect(smsSendMock).toHaveBeenCalledWith({
      from: '+13035550000',
      to: ['+13035551111'],
      message: 'Reminder text',
    });
    expect(providerId).toBe('sms-provider-id');
  });

  it('AcsSmsService supports SDK array response shape', async () => {
    smsSendMock.mockResolvedValue([{ successful: true, messageId: 'sms-provider-id-array' }]);

    const service = new AcsSmsService('endpoint=sb://test;', '+13035550000');

    const providerId = await service.sendSms({
      to: '+13035551111',
      message: 'Reminder text',
    });

    expect(providerId).toBe('sms-provider-id-array');
  });

  it('AcsSmsService throws when no recipient result is returned', async () => {
    smsSendMock.mockResolvedValue({ value: [] });

    const service = new AcsSmsService('endpoint=sb://test;', '+13035550000');

    await expect(
      service.sendSms({ to: '+13035551111', message: 'Reminder text' })
    ).rejects.toThrow('ACS SMS send did not return recipient results.');
  });

  it('AcsSmsService throws when recipient send is unsuccessful', async () => {
    smsSendMock.mockResolvedValue({ value: [{ successful: false, errorMessage: 'Blocked by carrier' }] });

    const service = new AcsSmsService('endpoint=sb://test;', '+13035550000');

    await expect(
      service.sendSms({ to: '+13035551111', message: 'Reminder text' })
    ).rejects.toThrow('ACS SMS send failed: Blocked by carrier');
  });

  it('TwilioSmsService sends using messaging service SID and returns message sid', async () => {
    twilioMessagesCreateMock.mockResolvedValue({ sid: 'SM1234567890' });

    const service = new TwilioSmsService('AC123', 'auth-token', 'MG123');
    const providerId = await service.sendSms({
      to: '+13035551111',
      message: 'Reminder text',
    });

    expect(twilio).toHaveBeenCalledWith('AC123', 'auth-token');
    expect(twilioMessagesCreateMock).toHaveBeenCalledWith({
      to: '+13035551111',
      body: 'Reminder text',
      messagingServiceSid: 'MG123',
    });
    expect(providerId).toBe('SM1234567890');
  });

  it('TwilioSmsService throws when response does not include sid', async () => {
    twilioMessagesCreateMock.mockResolvedValue({});

    const service = new TwilioSmsService('AC123', 'auth-token', 'MG123');

    await expect(
      service.sendSms({ to: '+13035551111', message: 'Reminder text' })
    ).rejects.toThrow('Twilio SMS send did not return a message SID.');
  });
});
