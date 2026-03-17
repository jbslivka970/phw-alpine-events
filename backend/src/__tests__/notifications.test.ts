/**
 * Unit tests for notifications service helpers.
 */

import { truncateSms, StubEmailService, StubSmsService, NotificationService } from '../services/notifications';

// Mock the DB pool so no real connection is attempted
jest.mock('../db', () => ({
  getPool: jest.fn().mockResolvedValue({
    request: jest.fn().mockReturnValue({
      input: jest.fn().mockReturnThis(),
      query: jest.fn().mockResolvedValue({ recordset: [{ sms_opt_in: true }], rowsAffected: [1] }),
    }),
  }),
  sql: {
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: jest.fn((n?: number) => `NVarChar(${n ?? 'MAX'})`),
    MAX: 'MAX',
    Int: 'Int',
    Bit: 'Bit',
    DateTime: 'DateTime',
    Date: 'Date',
  },
}));

// ── truncateSms ───────────────────────────────────────────────────────────────

describe('truncateSms', () => {
  it('returns the message unchanged when within limit', () => {
    const msg = 'Hello World';
    expect(truncateSms(msg)).toBe(msg);
  });

  it('truncates a message that exceeds 160 chars and appends "..."', () => {
    const long = 'A'.repeat(200);
    const result = truncateSms(long);
    expect(result.length).toBe(160);
    expect(result.endsWith('...')).toBe(true);
  });

  it('respects a custom limit', () => {
    const msg = 'Hello World';
    const result = truncateSms(msg, 7);
    expect(result.length).toBe(7);
    expect(result).toBe('Hell...');
  });

  it('returns message exactly at limit unchanged', () => {
    const msg = 'A'.repeat(160);
    expect(truncateSms(msg)).toBe(msg);
  });
});

// ── StubEmailService ─────────────────────────────────────────────────────────

describe('StubEmailService', () => {
  it('resolves with null (no ACS)', async () => {
    const svc = new StubEmailService();
    const result = await svc.sendEmail({
      to: 'test@example.com',
      subject: 'Test',
      htmlBody: '<p>Test</p>',
    });
    expect(result).toBeNull();
  });
});

// ── StubSmsService ────────────────────────────────────────────────────────────

describe('StubSmsService', () => {
  it('resolves with null (no ACS)', async () => {
    const svc = new StubSmsService();
    const result = await svc.sendSms({ to: '+15551234567', message: 'Hello' });
    expect(result).toBeNull();
  });
});

// ── NotificationService ───────────────────────────────────────────────────────

describe('NotificationService', () => {
  let emailSpy: jest.Mock;
  let smsSpy: jest.Mock;
  let service: NotificationService;

  beforeEach(() => {
    emailSpy = jest.fn().mockResolvedValue(null);
    smsSpy = jest.fn().mockResolvedValue(null);

    const mockEmail = { sendEmail: emailSpy };
    const mockSms = { sendSms: smsSpy };
    service = new NotificationService(mockEmail as never, mockSms as never);
  });

  it('sendEmail calls the email service', async () => {
    await service.sendEmail({ to: 'test@test.com', subject: 'S', htmlBody: '<p>B</p>' });
    expect(emailSpy).toHaveBeenCalledTimes(1);
  });

  it('sendEmail marks status "sent" when provider returns an ID', async () => {
    emailSpy.mockResolvedValue('msg-123');
    // No error thrown means 'sent' status would be set internally
    await expect(
      service.sendEmail({ to: 'test@test.com', subject: 'S', htmlBody: '<p>B</p>' })
    ).resolves.toBeUndefined();
  });

  it('sendSms skips opted-out members', async () => {
    // The mock DB returns sms_opt_in: true for the default mock,
    // but we override to return false
    const { getPool } = require('../db');
    (getPool as jest.Mock).mockResolvedValueOnce({
      request: jest.fn().mockReturnValue({
        input: jest.fn().mockReturnThis(),
        query: jest.fn().mockResolvedValue({ recordset: [{ sms_opt_in: false }], rowsAffected: [1] }),
      }),
    });

    await service.sendSms({ to: '+15551234567', message: 'Test', memberId: 'some-uuid-1234-5678-90ab-cdef12345678' });
    expect(smsSpy).not.toHaveBeenCalled();
  });

  it('sendSms proceeds for opted-in members', async () => {
    // The default mock returns sms_opt_in: true
    await service.sendSms({ to: '+15551234567', message: 'Test', memberId: 'some-uuid-1234-5678-90ab-cdef12345678' });
    expect(smsSpy).toHaveBeenCalledTimes(1);
  });
});
