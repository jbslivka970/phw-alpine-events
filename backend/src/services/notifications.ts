import { getPool, sql } from '../db';
import { renderTemplate } from '../templates/NotificationTemplate';
import { rsvpConfirmationTemplate } from '../templates/rsvpConfirmation';

interface NotificationPayload {
  eventId: string;
  eventTitle: string;
  recipientEmail?: string;
  recipientPhone?: string;
  memberId?: string;
  firstName?: string;
  eventDate?: string;
  rsvpStatus?: string;
}

type NotificationChannel = 'email' | 'sms';
type NotificationStatus = 'stubbed' | 'failed' | 'sent';

interface SendEmailOptions {
  to: string;
  subject: string;
  htmlBody: string;
  textBody?: string;
  templateId?: string;
  memberId?: string;
  eventId?: string;
}

interface SendSmsOptions {
  to: string;
  message: string;
  templateId?: string;
  memberId?: string;
  eventId?: string;
}

interface IEmailService {
  sendEmail(options: SendEmailOptions): Promise<void>;
}

interface ISmsService {
  sendSms(options: SendSmsOptions): Promise<void>;
}

class StubEmailService implements IEmailService {
  async sendEmail(options: SendEmailOptions): Promise<void> {
    console.log('[StubEmailService] Would send email', {
      to: options.to,
      subject: options.subject,
      templateId: options.templateId ?? null,
      memberId: options.memberId ?? null,
    });
  }
}

class StubSmsService implements ISmsService {
  async sendSms(options: SendSmsOptions): Promise<void> {
    console.log('[StubSmsService] Would send SMS', {
      to: options.to,
      templateId: options.templateId ?? null,
      memberId: options.memberId ?? null,
    });
  }
}

class NotificationService {
  constructor(
    private readonly emailService: IEmailService,
    private readonly smsService: ISmsService
  ) {}

  async sendEmail(options: SendEmailOptions): Promise<void> {
    let status: NotificationStatus = 'stubbed';
    let errorMessage: string | undefined;

    try {
      await this.emailService.sendEmail(options);
      status = 'stubbed';
    } catch (error) {
      status = 'failed';
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    await this.writeNotificationLog({
      channel: 'email',
      recipient: options.to,
      status,
      eventId: options.eventId,
      memberId: options.memberId,
      templateId: options.templateId,
      errorDetail: errorMessage,
    });
  }

  async sendSms(options: SendSmsOptions): Promise<void> {
    let status: NotificationStatus = 'stubbed';
    let errorMessage: string | undefined;

    try {
      await this.smsService.sendSms(options);
      status = 'stubbed';
    } catch (error) {
      status = 'failed';
      errorMessage = error instanceof Error ? error.message : String(error);
    }

    await this.writeNotificationLog({
      channel: 'sms',
      recipient: options.to,
      status,
      eventId: options.eventId,
      memberId: options.memberId,
      templateId: options.templateId,
      errorDetail: errorMessage,
    });
  }

  async writeSmsConsentLog(
    memberId: string,
    action: 'opt_in' | 'opt_out',
    source: 'import' | 'manual' | 'reply' | 'api' | 'system',
    notes?: string
  ): Promise<void> {
    const normalizedSource = source === 'reply' || source === 'import' || source === 'manual' ? source : 'manual';
    try {
      const pool = await getPool();
      await pool
        .request()
        .input('member_id', sql.UniqueIdentifier, memberId)
        .input('action', sql.NVarChar(10), action)
        .input('source', sql.NVarChar(20), normalizedSource)
        .input('notes', sql.NVarChar(500), notes ?? null)
        .query(
          `INSERT INTO sms_consent_log (consent_log_id, member_id, action, source, recorded_at, notes)
           VALUES (NEWID(), @member_id, @action, @source, GETUTCDATE(), @notes)`
        );
    } catch (error) {
      console.error('[NotificationService] Failed to write sms_consent_log', error);
    }
  }

  private async writeNotificationLog(entry: {
    channel: NotificationChannel;
    recipient: string;
    status: NotificationStatus;
    eventId?: string;
    memberId?: string;
    templateId?: string;
    errorDetail?: string;
  }): Promise<void> {
    try {
      const pool = await getPool();
      await pool
        .request()
        .input('event_id', sql.UniqueIdentifier, toNullableUuid(entry.eventId))
        .input('member_id', sql.UniqueIdentifier, toNullableUuid(entry.memberId))
        .input('template_id', sql.UniqueIdentifier, toNullableUuid(entry.templateId))
        .input('channel', sql.NVarChar(10), entry.channel)
        .input('recipient', sql.NVarChar(255), entry.recipient)
        .input('status', sql.NVarChar(20), entry.status)
        .input('provider_id', sql.NVarChar(255), null)
        .input('error_detail', sql.NVarChar(sql.MAX), entry.errorDetail ?? null)
        .query(
          `INSERT INTO notification_log
            (log_id, event_id, member_id, template_id, channel, recipient, status, provider_id, error_detail, sent_at)
           VALUES
            (NEWID(), @event_id, @member_id, @template_id, @channel, @recipient, @status, @provider_id, @error_detail, GETUTCDATE())`
        );
    } catch (error) {
      console.error('[NotificationService] Failed to write notification_log', error);
    }
  }
}

const notificationService = new NotificationService(new StubEmailService(), new StubSmsService());

function sendEventPublishedNotification(payload: NotificationPayload): void {
  console.log('[STUB] sendEventPublishedNotification', payload);
}

function sendEventCancelledNotification(payload: NotificationPayload): void {
  console.log('[STUB] sendEventCancelledNotification', payload);
}

function sendRsvpConfirmation(payload: NotificationPayload): void {
  const variables = {
    firstName: payload.firstName ?? 'Member',
    eventName: payload.eventTitle,
    eventDate: payload.eventDate ?? 'TBD',
    rsvpStatus: payload.rsvpStatus ?? 'confirmed',
  };

  if (payload.recipientEmail) {
    void notificationService.sendEmail({
      to: payload.recipientEmail,
      subject: renderTemplate(rsvpConfirmationTemplate.subjectTemplate ?? '', variables),
      htmlBody: renderTemplate(rsvpConfirmationTemplate.htmlBodyTemplate ?? '', variables),
      textBody: renderTemplate(rsvpConfirmationTemplate.textBodyTemplate ?? '', variables),
      templateId: rsvpConfirmationTemplate.templateId,
      memberId: payload.memberId,
      eventId: payload.eventId,
    });
  }

  if (payload.recipientPhone) {
    void notificationService.sendSms({
      to: payload.recipientPhone,
      message: renderTemplate(rsvpConfirmationTemplate.smsBodyTemplate ?? '', variables),
      templateId: rsvpConfirmationTemplate.templateId,
      memberId: payload.memberId,
      eventId: payload.eventId,
    });
  }

  if (!payload.recipientEmail && !payload.recipientPhone) {
    console.log('[STUB] sendRsvpConfirmation skipped (no recipient)', payload);
  }
}

function toNullableUuid(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const uuidV4Like = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidV4Like.test(value) ? value : null;
}

// ── TaVF notification stubs ────────────────────────────────────────────────────
// These are currently no-ops. Wire up real email/SMS sends when TAVF
// notification templates are created.

async function notifyNewPosting(_email: string, postingId: string): Promise<void> {
  console.log(`[notifications] notifyNewPosting stub called for postingId=${postingId}`);
}

async function notifyApplicationReceived(_email: string, applicationId: string): Promise<void> {
  console.log(`[notifications] notifyApplicationReceived stub called for applicationId=${applicationId}`);
}

async function notifyMatchConfirmed(_guideEmail: string, matchId: string, _vetEmail: string): Promise<void> {
  console.log(`[notifications] notifyMatchConfirmed stub called for matchId=${matchId}`);
}

async function notifyMatchCancelled(_guideEmail: string, matchId: string, _vetEmail: string): Promise<void> {
  console.log(`[notifications] notifyMatchCancelled stub called for matchId=${matchId}`);
}

export {
  NotificationService,
  notifyApplicationReceived,
  notifyMatchCancelled,
  notifyMatchConfirmed,
  notifyNewPosting,
  sendEventCancelledNotification,
  sendEventPublishedNotification,
  sendRsvpConfirmation,
  StubEmailService,
  StubSmsService,
  notificationService,
};
export type {
  NotificationPayload,
  SendEmailOptions,
  SendSmsOptions,
  IEmailService,
  ISmsService,
  NotificationChannel,
  NotificationStatus,
};