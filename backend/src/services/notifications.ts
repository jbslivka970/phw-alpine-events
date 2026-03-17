import { EmailClient } from '@azure/communication-email';
import { SmsClient } from '@azure/communication-sms';
import { getPool, sql } from '../db';
import { loadAcsConfig } from '../config';
import { renderTemplate } from '../templates/NotificationTemplate';
import { rsvpConfirmationTemplate } from '../templates/rsvpConfirmation';
import { eventInviteTemplate } from '../templates/eventInvite';
import { eventCancellationTemplate } from '../templates/eventCancellation';

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
type NotificationStatus = 'stubbed' | 'failed' | 'sent' | 'skipped';

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
  sendEmail(options: SendEmailOptions): Promise<string | null>;
}

interface ISmsService {
  sendSms(options: SendSmsOptions): Promise<string | null>;
}

// ── Stub services ─────────────────────────────────────────────────────────────

class StubEmailService implements IEmailService {
  async sendEmail(options: SendEmailOptions): Promise<string | null> {
    console.log('[StubEmailService] Would send email', {
      to: options.to,
      subject: options.subject,
      templateId: options.templateId ?? null,
      memberId: options.memberId ?? null,
    });
    return null;
  }
}

class StubSmsService implements ISmsService {
  async sendSms(options: SendSmsOptions): Promise<string | null> {
    console.log('[StubSmsService] Would send SMS', {
      to: options.to,
      templateId: options.templateId ?? null,
      memberId: options.memberId ?? null,
    });
    return null;
  }
}

// ── ACS Email service ─────────────────────────────────────────────────────────

class AcsEmailService implements IEmailService {
  private client: EmailClient;
  private senderAddress: string;

  constructor(connectionString: string, senderAddress: string) {
    this.client = new EmailClient(connectionString);
    this.senderAddress = senderAddress;
  }

  async sendEmail(options: SendEmailOptions): Promise<string | null> {
    const poller = await this.client.beginSend({
      senderAddress: this.senderAddress,
      // Per PRD §6.3.2: use BCC so the To field shows the sender address
      recipients: {
        to: [{ address: this.senderAddress }],
        bcc: [{ address: options.to }],
      },
      content: {
        subject: options.subject,
        html: options.htmlBody,
        plainText: options.textBody,
      },
    });

    const result = await poller.pollUntilDone({ abortSignal: AbortSignal.timeout(60_000) });
    if (result.status !== 'Succeeded') {
      throw new Error(`ACS email send failed with status: ${result.status}`);
    }
    return result.id ?? null;
  }
}

// ── ACS SMS service ───────────────────────────────────────────────────────────

class AcsSmsService implements ISmsService {
  private client: SmsClient;
  private fromNumber: string;

  constructor(connectionString: string, fromNumber: string) {
    this.client = new SmsClient(connectionString);
    this.fromNumber = fromNumber;
  }

  async sendSms(options: SendSmsOptions): Promise<string | null> {
    const message = truncateSms(options.message);
    const results = await this.client.send({
      from: this.fromNumber,
      to: [options.to],
      message,
    });
    const result = results[0];
    if (!result.successful) {
      throw new Error(`ACS SMS send failed: ${result.errorMessage ?? 'unknown error'}`);
    }
    return result.messageId ?? null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Truncate an SMS message to the carrier limit (default 160 chars).
 * If over limit, truncates to limit-3 and appends "...".
 */
function truncateSms(message: string, limit = 160): string {
  if (message.length <= limit) return message;
  console.warn(`[SMS] Message truncated from ${message.length} to ${limit} chars`);
  return message.slice(0, limit - 3) + '...';
}

function toNullableUuid(value: string | undefined): string | null {
  if (!value) return null;
  const uuidV4Like = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidV4Like.test(value) ? value : null;
}

// ── Core notification service ─────────────────────────────────────────────────

class NotificationService {
  constructor(
    private readonly emailService: IEmailService,
    private readonly smsService: ISmsService
  ) {}

  async sendEmail(options: SendEmailOptions): Promise<void> {
    let status: NotificationStatus = 'stubbed';
    let errorMessage: string | undefined;
    let providerId: string | null = null;

    try {
      providerId = await this.emailService.sendEmail(options);
      status = providerId !== null ? 'sent' : 'stubbed';
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
      providerId,
    });
  }

  async sendSms(options: SendSmsOptions): Promise<void> {
    // Check sms_opt_in before sending
    if (options.memberId) {
      const optedIn = await this.isSmsOptIn(options.memberId);
      if (!optedIn) {
        await this.writeNotificationLog({
          channel: 'sms',
          recipient: options.to,
          status: 'skipped',
          eventId: options.eventId,
          memberId: options.memberId,
          templateId: options.templateId,
        });
        return;
      }
    }

    let status: NotificationStatus = 'stubbed';
    let errorMessage: string | undefined;
    let providerId: string | null = null;

    try {
      providerId = await this.smsService.sendSms(options);
      status = providerId !== null ? 'sent' : 'stubbed';
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
      providerId,
    });
  }

  private async isSmsOptIn(memberId: string): Promise<boolean> {
    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('member_id', sql.UniqueIdentifier, memberId)
        .query<{ sms_opt_in: boolean | null }>(
          'SELECT sms_opt_in FROM member WHERE member_id = @member_id'
        );
      return result.recordset[0]?.sms_opt_in === true;
    } catch {
      return false;
    }
  }

  async writeSmsConsentLog(
    memberId: string,
    action: 'opt_in' | 'opt_out',
    source: 'import' | 'manual' | 'reply' | 'api' | 'system',
    notes?: string
  ): Promise<void> {
    const normalizedSource =
      source === 'reply' || source === 'import' || source === 'manual' ? source : 'manual';
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
    providerId?: string | null;
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
        .input('provider_id', sql.NVarChar(255), entry.providerId ?? null)
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

// ── Singleton factory ─────────────────────────────────────────────────────────

function createNotificationService(): NotificationService {
  const acsConfig = loadAcsConfig();
  let emailService: IEmailService;
  let smsService: ISmsService;

  if (acsConfig.isConfigured && acsConfig.emailFrom) {
    emailService = new AcsEmailService(acsConfig.connectionString, acsConfig.emailFrom);
  } else {
    console.warn('[notifications] ACS_CONNECTION_STRING not set — using stub email service');
    emailService = new StubEmailService();
  }

  if (acsConfig.isConfigured && acsConfig.smsFrom) {
    smsService = new AcsSmsService(acsConfig.connectionString, acsConfig.smsFrom);
  } else {
    console.warn('[notifications] ACS SMS not configured — using stub SMS service');
    smsService = new StubSmsService();
  }

  return new NotificationService(emailService, smsService);
}

const notificationService = createNotificationService();

// ── Event dispatch functions ──────────────────────────────────────────────────

interface EventDispatchPayload {
  event_id: string;
  title: string;
  event_date: Date | string;
  location: string | null;
  description: string | null;
}

async function sendEventPublishedNotification(payload: EventDispatchPayload): Promise<void> {
  try {
    const pool = await getPool();

    // Get all targeted groups for this event
    const targetsResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, payload.event_id)
      .query<{ group_id: string }>(
        `SELECT group_id FROM event_notification_target WHERE event_id = @event_id`
      );

    const groupIds = targetsResult.recordset.map((r) => r.group_id);
    if (groupIds.length === 0) {
      console.log('[notifications] No notification targets for event', payload.event_id);
      return;
    }

    const memberSet = new Set<string>();
    const memberMap = new Map<string, {
      email: string | null;
      phone: string | null;
      first_name: string;
    }>();

    for (const groupId of groupIds) {
      const membersResult = await pool
        .request()
        .input('group_id', sql.UniqueIdentifier, groupId)
        .query<{
          member_id: string;
          email: string | null;
          mobile_phone: string | null;
          first_name: string;
          email_opt_out: boolean | null;
          sms_opt_in: boolean | null;
        }>(
          `SELECT m.member_id, m.email, m.mobile_phone, m.first_name, m.email_opt_out, m.sms_opt_in
           FROM member m
           INNER JOIN member_group mg ON mg.member_id = m.member_id
           WHERE mg.group_id = @group_id AND m.is_active = 1`
        );
      for (const row of membersResult.recordset) {
        if (!memberSet.has(row.member_id)) {
          memberSet.add(row.member_id);
          memberMap.set(row.member_id, {
            email: row.email_opt_out ? null : row.email,
            phone: row.sms_opt_in ? row.mobile_phone : null,
            first_name: row.first_name,
          });
        }
      }
    }

    const eventDate = new Date(payload.event_date);
    const dateStr = eventDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const timeStr = eventDate.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const frontendUrl = process.env.FRONTEND_URL ?? 'https://phw-alpine-events.azurewebsites.net';
    const variables = {
      eventTitle: payload.title,
      eventDate: dateStr,
      eventTime: timeStr,
      location: payload.location ?? 'TBD',
      description: payload.description ?? '',
      rsvpUrl: `${frontendUrl}/events/${payload.event_id}`,
      unsubscribeUrl: `${frontendUrl}/unsubscribe`,
    };

    for (const [memberId, member] of memberMap) {
      if (member.email) {
        await notificationService.sendEmail({
          to: member.email,
          subject: renderTemplate(eventInviteTemplate.subjectTemplate ?? '', variables),
          htmlBody: renderTemplate(eventInviteTemplate.htmlBodyTemplate ?? '', variables),
          textBody: renderTemplate(eventInviteTemplate.textBodyTemplate ?? '', variables),
          templateId: eventInviteTemplate.templateId,
          memberId,
          eventId: payload.event_id,
        });
      }
      if (member.phone) {
        await notificationService.sendSms({
          to: member.phone,
          message: renderTemplate(eventInviteTemplate.smsBodyTemplate ?? '', variables),
          templateId: eventInviteTemplate.templateId,
          memberId,
          eventId: payload.event_id,
        });
      }
    }
  } catch (error) {
    console.error('[notifications] sendEventPublishedNotification failed', error);
  }
}

async function sendEventCancelledNotification(payload: EventDispatchPayload): Promise<void> {
  try {
    const pool = await getPool();

    // Get all members who responded yes/maybe/waitlist
    const respondentsResult = await pool
      .request()
      .input('event_id', sql.UniqueIdentifier, payload.event_id)
      .query<{
        member_id: string;
        email: string | null;
        mobile_phone: string | null;
        email_opt_out: boolean | null;
        sms_opt_in: boolean | null;
      }>(
        `SELECT DISTINCT m.member_id, m.email, m.mobile_phone, m.email_opt_out, m.sms_opt_in
         FROM event_response er
         INNER JOIN member m ON m.member_id = er.member_id
         WHERE er.event_id = @event_id
           AND er.response IN ('yes', 'maybe', 'waitlist')
           AND m.is_active = 1`
      );

    const eventDate = new Date(payload.event_date);
    const dateStr = eventDate.toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    const variables = {
      eventTitle: payload.title,
      eventDate: dateStr,
      location: payload.location ?? 'TBD',
    };

    for (const row of respondentsResult.recordset) {
      if (!row.email_opt_out && row.email) {
        await notificationService.sendEmail({
          to: row.email,
          subject: renderTemplate(eventCancellationTemplate.subjectTemplate ?? '', variables),
          htmlBody: renderTemplate(eventCancellationTemplate.htmlBodyTemplate ?? '', variables),
          textBody: renderTemplate(eventCancellationTemplate.textBodyTemplate ?? '', variables),
          templateId: eventCancellationTemplate.templateId,
          memberId: row.member_id,
          eventId: payload.event_id,
        });
      }
      if (row.sms_opt_in && row.mobile_phone) {
        await notificationService.sendSms({
          to: row.mobile_phone,
          message: renderTemplate(eventCancellationTemplate.smsBodyTemplate ?? '', variables),
          templateId: eventCancellationTemplate.templateId,
          memberId: row.member_id,
          eventId: payload.event_id,
        });
      }
    }
  } catch (error) {
    console.error('[notifications] sendEventCancelledNotification failed', error);
  }
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

// ── TaVF notification functions ───────────────────────────────────────────────

async function notifyNewPosting(_email: string, postingId: string): Promise<void> {
  try {
    const pool = await getPool();
    const membersResult = await pool
      .request()
      .query<{ email: string | null; member_id: string }>(
        `SELECT m.member_id, m.email
         FROM member m
         INNER JOIN member_group mg ON mg.member_id = m.member_id
         INNER JOIN [group] g ON g.group_id = mg.group_id
         WHERE g.name = 'All' AND m.is_active = 1
           AND m.email IS NOT NULL
           AND (m.email_opt_out IS NULL OR m.email_opt_out = 0)`
      );

    const frontendUrl = process.env.FRONTEND_URL ?? 'https://phw-alpine-events.azurewebsites.net';
    for (const member of membersResult.recordset) {
      if (member.email) {
        await notificationService.sendEmail({
          to: member.email,
          subject: 'New TAVF Opportunity Available',
          htmlBody: `<p>A new Take a Vet Fishing opportunity is available. <a href="${frontendUrl}/tavf/postings/${postingId}">View posting</a></p>`,
          memberId: member.member_id,
        });
      }
    }
  } catch (error) {
    console.error(`[notifications] notifyNewPosting failed for postingId=${postingId}`, error);
  }
}

async function notifyApplicationReceived(_email: string, applicationId: string): Promise<void> {
  console.log(`[notifications] notifyApplicationReceived stub called for applicationId=${applicationId}`);
}

async function notifyMatchConfirmed(guideEmail: string, matchId: string, vetEmail: string): Promise<void> {
  const body = `<p>Your Take a Vet Fishing match (ID: ${matchId}) has been confirmed. Please check the platform for details.</p>`;
  if (guideEmail) {
    await notificationService.sendEmail({
      to: guideEmail,
      subject: 'TAVF Match Confirmed',
      htmlBody: body,
    });
  }
  if (vetEmail) {
    await notificationService.sendEmail({
      to: vetEmail,
      subject: 'TAVF Match Confirmed',
      htmlBody: body,
    });
  }
}

async function notifyMatchCancelled(guideEmail: string, matchId: string, vetEmail: string): Promise<void> {
  const body = `<p>Your Take a Vet Fishing match (ID: ${matchId}) has been cancelled.</p>`;
  if (guideEmail) {
    await notificationService.sendEmail({
      to: guideEmail,
      subject: 'TAVF Match Cancelled',
      htmlBody: body,
    });
  }
  if (vetEmail) {
    await notificationService.sendEmail({
      to: vetEmail,
      subject: 'TAVF Match Cancelled',
      htmlBody: body,
    });
  }
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
  AcsEmailService,
  AcsSmsService,
  notificationService,
  truncateSms,
};
export type {
  NotificationPayload,
  EventDispatchPayload,
  SendEmailOptions,
  SendSmsOptions,
  IEmailService,
  ISmsService,
  NotificationChannel,
  NotificationStatus,
};
