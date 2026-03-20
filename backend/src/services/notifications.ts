import { EmailClient } from '@azure/communication-email';
import { SmsClient } from '@azure/communication-sms';
import { getPool, sql } from '../db';
import { loadAcsConfig } from '../config';
import { renderTemplate } from '../templates/NotificationTemplate';
import { eventCancellationTemplate } from '../templates/eventCancellation';
import { eventInviteTemplate } from '../templates/eventInvite';
import { eventUpdateTemplate } from '../templates/eventUpdate';
import { rsvpConfirmationTemplate } from '../templates/rsvpConfirmation';
import { waitlistPromotionTemplate } from '../templates/waitlistPromotion';
import { buildMemberRsvpUrls } from './rsvpLinkService';

interface RsvpNotificationPayload {
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
type NotificationMode = 'real' | 'partial' | 'stub';

interface NotificationRuntimeStatus {
  mode: NotificationMode;
  strictModeEnabled: boolean;
  emailServiceMode: 'real' | 'stub';
  smsServiceMode: 'real' | 'stub';
  reasons: string[];
}

class NotificationConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationConfigurationError';
  }
}

interface EventNotificationPayload {
  event_id: string;
  title: string;
  event_date: Date | string;
  location: string | null;
  description: string | null;
  updateReason?: string | null;
}

interface EventUpdateNotificationPayload extends EventNotificationPayload {
  changedFields: string[];
  updateReason?: string | null;
}

interface WaitlistPromotionNotificationPayload {
  event_id: string;
  title: string;
  event_date: Date | string;
  location: string | null;
  description: string | null;
  member_id: string;
  preferredChannel?: string | null;
  recipientEmail?: string | null;
  recipientPhone?: string | null;
  smsOptIn?: boolean;
  emailOptOut?: boolean;
  expires_at: Date | string;
}

interface SendEmailOptions {
  to: string;
  subject: string;
  htmlBody: string;
  textBody?: string;
  templateId?: string;
  memberId?: string;
  eventId?: string;
  operationType?: string;
  operationReason?: string;
}

interface SendSmsOptions {
  to: string;
  message: string;
  templateId?: string;
  memberId?: string;
  eventId?: string;
  bypassOptInCheck?: boolean;
  operationType?: string;
  operationReason?: string;
}

interface IEmailService {
  sendEmail(options: SendEmailOptions): Promise<string | undefined>;
}

interface ISmsService {
  sendSms(options: SendSmsOptions): Promise<string | undefined>;
}

class StubEmailService implements IEmailService {
  async sendEmail(options: SendEmailOptions): Promise<string | undefined> {
    console.log('[StubEmailService] Would send email', {
      to: options.to,
      subject: options.subject,
      templateId: options.templateId ?? null,
      memberId: options.memberId ?? null,
    });
    return undefined;
  }
}

class StubSmsService implements ISmsService {
  async sendSms(options: SendSmsOptions): Promise<string | undefined> {
    console.log('[StubSmsService] Would send SMS', {
      to: options.to,
      templateId: options.templateId ?? null,
      memberId: options.memberId ?? null,
    });
    return undefined;
  }
}

class AcsEmailService implements IEmailService {
  private readonly client: EmailClient;

  constructor(
    private readonly connectionString: string,
    private readonly senderAddress: string
  ) {
    this.client = new EmailClient(this.connectionString);
  }

  async sendEmail(options: SendEmailOptions): Promise<string | undefined> {
    const poller = await this.client.beginSend({
      senderAddress: this.senderAddress,
      content: {
        subject: options.subject,
        plainText: options.textBody,
        html: options.htmlBody,
      },
      recipients: {
        to: [{ address: this.senderAddress }],
        bcc: [{ address: options.to }],
      },
    });

    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error('ACS email send timed out after 60 seconds.'));
      }, 60_000);
    });

    const result = (await Promise.race([poller.pollUntilDone(), timeout])) as {
      id?: string;
      messageId?: string;
      status?: string;
      error?: unknown;
    };

    if (!result || (result.status && result.status.toLowerCase() === 'failed')) {
      throw new Error(`ACS email send failed: ${JSON.stringify(result?.error ?? result)}`);
    }

    return result.id ?? result.messageId;
  }
}

class AcsSmsService implements ISmsService {
  private readonly client: SmsClient;

  constructor(
    private readonly connectionString: string,
    private readonly fromNumber: string
  ) {
    this.client = new SmsClient(this.connectionString);
  }

  async sendSms(options: SendSmsOptions): Promise<string | undefined> {
    const rawResult = await this.client.send({
      from: this.fromNumber,
      to: [options.to],
      message: options.message,
    });

    const result = rawResult as {
      value?: Array<{ successful?: boolean; messageId?: string; errorMessage?: string }>;
    };
    const firstRecipient = result.value?.[0];

    if (!firstRecipient) {
      throw new Error('ACS SMS send did not return recipient results.');
    }

    if (firstRecipient.successful === false) {
      throw new Error(`ACS SMS send failed: ${firstRecipient.errorMessage ?? 'Unknown error'}`);
    }

    return firstRecipient.messageId;
  }
}

class NotificationService {
  constructor(
    private readonly emailService: IEmailService,
    private readonly smsService: ISmsService,
    private readonly isRealEmailService: boolean,
    private readonly isRealSmsService: boolean
  ) {}

  async sendEmail(options: SendEmailOptions): Promise<void> {
    let status: NotificationStatus = this.isRealEmailService ? 'sent' : 'stubbed';
    let errorMessage: string | undefined;
    let providerId: string | undefined;

    try {
      providerId = await this.emailService.sendEmail(options);
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
      operationType: options.operationType,
      operationReason: options.operationReason,
      errorDetail: errorMessage,
      providerId,
    });
  }

  async sendSms(options: SendSmsOptions): Promise<void> {
    const normalizedMessage = truncateSms(options.message);
    if (normalizedMessage !== options.message) {
      console.warn('[NotificationService] SMS exceeded 160 characters and was truncated.');
    }

    if (options.memberId && !options.bypassOptInCheck) {
      const smsOptIn = await this.memberHasSmsOptIn(options.memberId);
      if (!smsOptIn) {
        await this.writeNotificationLog({
          channel: 'sms',
          recipient: options.to,
          status: 'skipped',
          eventId: options.eventId,
          memberId: options.memberId,
          templateId: options.templateId,
          operationType: options.operationType,
          operationReason: options.operationReason,
        });
        return;
      }
    }

    let status: NotificationStatus = this.isRealSmsService ? 'sent' : 'stubbed';
    let errorMessage: string | undefined;
    let providerId: string | undefined;

    try {
      providerId = await this.smsService.sendSms({
        ...options,
        message: normalizedMessage,
      });
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
      operationType: options.operationType,
      operationReason: options.operationReason,
      errorDetail: errorMessage,
      providerId,
    });
  }

  private async memberHasSmsOptIn(memberId: string): Promise<boolean> {
    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('member_id', sql.UniqueIdentifier, memberId)
        .query<{ sms_opt_in: boolean | null }>('SELECT sms_opt_in FROM member WHERE member_id = @member_id');

      const member = result.recordset[0];
      return Boolean(member?.sms_opt_in);
    } catch (error) {
      console.error('[NotificationService] Failed to check sms_opt_in, skipping SMS send.', error);
      return false;
    }
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
    operationType?: string;
    operationReason?: string;
    errorDetail?: string;
    providerId?: string;
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
        .input('operation_type', sql.NVarChar(50), entry.operationType ?? null)
        .input('operation_reason', sql.NVarChar(500), entry.operationReason ?? null)
        .input('provider_id', sql.NVarChar(255), entry.providerId ?? null)
        .input('error_detail', sql.NVarChar(sql.MAX), entry.errorDetail ?? null)
        .query(
          `INSERT INTO notification_log
            (log_id, event_id, member_id, template_id, channel, recipient, status, operation_type, operation_reason, provider_id, error_detail, sent_at)
           VALUES
            (NEWID(), @event_id, @member_id, @template_id, @channel, @recipient, @status, @operation_type, @operation_reason, @provider_id, @error_detail, GETUTCDATE())`
        );
    } catch (error) {
      console.error('[NotificationService] Failed to write notification_log', error);
    }
  }
}

const acsConfig = loadAcsConfig();
let emailService: IEmailService = new StubEmailService();
let smsService: ISmsService = new StubSmsService();
let isRealEmailService = false;
let isRealSmsService = false;
const notificationInitReasons: string[] = [];
const hasValidAcsConnectionString = Boolean(
  acsConfig.connectionString &&
    /endpoint\s*=\s*https?:\/\//i.test(acsConfig.connectionString) &&
    /accesskey\s*=/i.test(acsConfig.connectionString)
);

const strictModeEnabled = /^(1|true|yes|on)$/i.test(process.env['NOTIFICATIONS_STRICT_MODE'] ?? '');

if (!acsConfig.isConfigured) {
  notificationInitReasons.push('ACS core configuration is incomplete (connection string or email sender missing).');
  console.warn('[NotificationService] ACS not configured. Email and SMS sends are running in stub mode.');
} else if (!hasValidAcsConnectionString) {
  notificationInitReasons.push('ACS connection string is invalid.');
  console.warn('[NotificationService] ACS connection string appears invalid. Email and SMS sends are running in stub mode.');
} else {
  try {
    emailService = new AcsEmailService(acsConfig.connectionString ?? '', acsConfig.emailFrom ?? '');
    isRealEmailService = true;
  } catch (error) {
    notificationInitReasons.push('Failed to initialize ACS email client.');
    console.warn('[NotificationService] Failed to initialize ACS email client, falling back to stub mode.', error);
  }

  if (!acsConfig.smsFrom) {
    notificationInitReasons.push('ACS_SMS_FROM is missing; SMS service is unavailable.');
    console.warn('[NotificationService] ACS_SMS_FROM is not set. SMS sends are running in stub mode.');
  } else {
    try {
      smsService = new AcsSmsService(acsConfig.connectionString ?? '', acsConfig.smsFrom);
      isRealSmsService = true;
    } catch (error) {
      notificationInitReasons.push('Failed to initialize ACS SMS client.');
      console.warn('[NotificationService] Failed to initialize ACS SMS client, falling back to stub mode.', error);
    }
  }
}

const notificationService = new NotificationService(
  emailService,
  smsService,
  isRealEmailService,
  isRealSmsService
);

function getNotificationRuntimeStatus(): NotificationRuntimeStatus {
  const mode: NotificationMode = isRealEmailService && isRealSmsService
    ? 'real'
    : (isRealEmailService || isRealSmsService)
      ? 'partial'
      : 'stub';

  const reasons = [...notificationInitReasons];
  if (strictModeEnabled) {
    reasons.push('NOTIFICATIONS_STRICT_MODE is enabled.');
  }

  return {
    mode,
    strictModeEnabled,
    emailServiceMode: isRealEmailService ? 'real' : 'stub',
    smsServiceMode: isRealSmsService ? 'real' : 'stub',
    reasons,
  };
}

function assertChannelsAvailable(channels: { emailNeeded: boolean; smsNeeded: boolean }, context: string): void {
  if (!strictModeEnabled) {
    return;
  }

  if (channels.emailNeeded && !isRealEmailService) {
    throw new NotificationConfigurationError(
      `Notification channel unavailable for ${context}: email delivery is required but ACS email is not configured.`
    );
  }

  if (channels.smsNeeded && !isRealSmsService) {
    throw new NotificationConfigurationError(
      `Notification channel unavailable for ${context}: SMS delivery is required but ACS SMS is not configured.`
    );
  }
}

async function assertEventPublishedNotificationReady(eventId: string): Promise<void> {
  const pool = await getPool();
  const recipientsResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .query<{
      email: string | null;
      mobile_phone: string | null;
      sms_opt_in: boolean;
      email_opt_out: boolean;
    }>(
      `SELECT
          m.email,
          m.mobile_phone,
          m.sms_opt_in,
          m.email_opt_out
       FROM event_notification_target ent
       LEFT JOIN member_group mg ON mg.group_id = ent.group_id
       LEFT JOIN member m ON m.member_id = COALESCE(ent.member_id, mg.member_id)
       WHERE ent.event_id = @event_id
         AND m.member_id IS NOT NULL`
    );

  const emailNeeded = recipientsResult.recordset.some((recipient) => Boolean(!recipient.email_opt_out && recipient.email));
  const smsNeeded = recipientsResult.recordset.some((recipient) => Boolean(recipient.mobile_phone && recipient.sms_opt_in));
  assertChannelsAvailable({ emailNeeded, smsNeeded }, 'event_published');
}

async function assertEventCancelledNotificationReady(eventId: string): Promise<void> {
  const pool = await getPool();
  const recipientsResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .query<{
      email: string | null;
      mobile_phone: string | null;
      sms_opt_in: boolean;
      email_opt_out: boolean;
    }>(
      `SELECT DISTINCT
          m.email,
          m.mobile_phone,
          m.sms_opt_in,
          m.email_opt_out
       FROM event_response er
       INNER JOIN member m ON m.member_id = er.member_id
       WHERE er.event_id = @event_id
         AND er.response IN ('yes', 'no', 'maybe', 'waitlist')`
    );

  const emailNeeded = recipientsResult.recordset.some((recipient) => Boolean(!recipient.email_opt_out && recipient.email));
  const smsNeeded = recipientsResult.recordset.some((recipient) => Boolean(recipient.mobile_phone && recipient.sms_opt_in));
  assertChannelsAvailable({ emailNeeded, smsNeeded }, 'event_cancelled');
}

async function assertEventUpdatedNotificationReady(eventId: string): Promise<void> {
  const pool = await getPool();
  const recipientsResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .query<{
      email: string | null;
      mobile_phone: string | null;
      sms_opt_in: boolean;
      email_opt_out: boolean;
    }>(
      `SELECT DISTINCT
          m.email,
          m.mobile_phone,
          m.sms_opt_in,
          m.email_opt_out
       FROM event_response er
       INNER JOIN member m ON m.member_id = er.member_id
       WHERE er.event_id = @event_id
         AND er.response IN ('yes', 'maybe', 'waitlist')`
    );

  const emailNeeded = recipientsResult.recordset.some((recipient) => Boolean(!recipient.email_opt_out && recipient.email));
  const smsNeeded = recipientsResult.recordset.some((recipient) => Boolean(recipient.mobile_phone && recipient.sms_opt_in));
  assertChannelsAvailable({ emailNeeded, smsNeeded }, 'event_updated');
}

async function sendEventPublishedNotification(payload: EventNotificationPayload): Promise<void> {
  await assertEventPublishedNotificationReady(payload.event_id);

  const pool = await getPool();
  const recipientsResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, payload.event_id)
    .query<{
      member_id: string;
      group_context_id: string | null;
      first_name: string | null;
      email: string;
      mobile_phone: string | null;
      sms_opt_in: boolean;
      email_opt_out: boolean;
    }>(
      `SELECT
          m.member_id,
          ent.group_id AS group_context_id,
          m.first_name,
          m.email,
          m.mobile_phone,
          m.sms_opt_in,
          m.email_opt_out
       FROM event_notification_target ent
       LEFT JOIN member_group mg ON mg.group_id = ent.group_id
       LEFT JOIN member m ON m.member_id = COALESCE(ent.member_id, mg.member_id)
       WHERE ent.event_id = @event_id
         AND m.member_id IS NOT NULL`
    );

  for (const recipient of recipientsResult.recordset) {
    const variables = buildEventVariables(payload, recipient.member_id, recipient.group_context_id ?? undefined);
    if (!recipient.email_opt_out && recipient.email) {
      await notificationService.sendEmail({
        to: recipient.email,
        subject: renderTemplate(eventInviteTemplate.subjectTemplate ?? '', variables),
        htmlBody: renderTemplate(eventInviteTemplate.htmlBodyTemplate ?? '', variables),
        textBody: renderTemplate(eventInviteTemplate.textBodyTemplate ?? '', variables),
        templateId: eventInviteTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_published',
      });
    }

    if (recipient.mobile_phone && recipient.sms_opt_in) {
      await notificationService.sendSms({
        to: recipient.mobile_phone,
        message: renderTemplate(eventInviteTemplate.smsBodyTemplate ?? '', variables),
        templateId: eventInviteTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_published',
      });
    }
  }
}

async function sendEventCancelledNotification(payload: EventNotificationPayload): Promise<void> {
  await assertEventCancelledNotificationReady(payload.event_id);

  const pool = await getPool();
  const recipientsResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, payload.event_id)
    .query<{
      member_id: string;
      first_name: string | null;
      email: string;
      mobile_phone: string | null;
      sms_opt_in: boolean;
      email_opt_out: boolean;
      response_channel: string | null;
    }>(
      `SELECT DISTINCT
          m.member_id,
          m.first_name,
          m.email,
          m.mobile_phone,
          m.sms_opt_in,
          m.email_opt_out,
          er.response_channel
       FROM event_response er
       INNER JOIN member m ON m.member_id = er.member_id
       WHERE er.event_id = @event_id
         AND er.response IN ('yes', 'no', 'maybe', 'waitlist')`
    );

  const variables = buildEventVariables(payload);

  for (const recipient of recipientsResult.recordset) {
    const preferredChannel = pickPreferredChannel(recipient.response_channel);
    const canEmail = Boolean(!recipient.email_opt_out && recipient.email);
    const canSms = Boolean(recipient.mobile_phone && recipient.sms_opt_in);

    if (preferredChannel === 'sms' && canSms) {
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderTemplate(eventCancellationTemplate.smsBodyTemplate ?? '', variables),
        templateId: eventCancellationTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_cancelled',
        operationReason: payload.updateReason ?? undefined,
      });
      continue;
    }

    if (canEmail) {
      await notificationService.sendEmail({
        to: recipient.email,
        subject: renderTemplate(eventCancellationTemplate.subjectTemplate ?? '', variables),
        htmlBody: renderTemplate(eventCancellationTemplate.htmlBodyTemplate ?? '', variables),
        textBody: renderTemplate(eventCancellationTemplate.textBodyTemplate ?? '', variables),
        templateId: eventCancellationTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_cancelled',
        operationReason: payload.updateReason ?? undefined,
      });
      continue;
    }

    if (canSms) {
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderTemplate(eventCancellationTemplate.smsBodyTemplate ?? '', variables),
        templateId: eventCancellationTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_cancelled',
        operationReason: payload.updateReason ?? undefined,
      });
    }
  }
}

async function sendEventUpdatedNotification(payload: EventUpdateNotificationPayload): Promise<void> {
  if (payload.changedFields.length === 0) {
    return;
  }

  await assertEventUpdatedNotificationReady(payload.event_id);

  const pool = await getPool();
  const recipientsResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, payload.event_id)
    .query<{
      member_id: string;
      email: string;
      mobile_phone: string | null;
      sms_opt_in: boolean;
      email_opt_out: boolean;
      response_channel: string | null;
    }>(
      `SELECT DISTINCT
          m.member_id,
          m.email,
          m.mobile_phone,
          m.sms_opt_in,
          m.email_opt_out,
          er.response_channel
       FROM event_response er
       INNER JOIN member m ON m.member_id = er.member_id
       WHERE er.event_id = @event_id
         AND er.response IN ('yes', 'maybe', 'waitlist')`
    );

  const changeSummary = summarizeChangedFields(payload.changedFields);

  for (const recipient of recipientsResult.recordset) {
    const variables = {
      ...buildEventVariables(payload, recipient.member_id),
      changeSummary,
      updateReason: payload.updateReason?.trim() || 'Schedule or logistics were adjusted by the coordinator.',
    };
    const preferredChannel = pickPreferredChannel(recipient.response_channel);
    const canEmail = Boolean(!recipient.email_opt_out && recipient.email);
    const canSms = Boolean(recipient.mobile_phone && recipient.sms_opt_in);

    if (preferredChannel === 'sms' && canSms) {
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderTemplate(eventUpdateTemplate.smsBodyTemplate ?? '', variables),
        templateId: eventUpdateTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_updated',
        operationReason: payload.updateReason ?? undefined,
      });
      continue;
    }

    if (canEmail) {
      await notificationService.sendEmail({
        to: recipient.email,
        subject: renderTemplate(eventUpdateTemplate.subjectTemplate ?? '', variables),
        htmlBody: renderTemplate(eventUpdateTemplate.htmlBodyTemplate ?? '', variables),
        textBody: renderTemplate(eventUpdateTemplate.textBodyTemplate ?? '', variables),
        templateId: eventUpdateTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_updated',
        operationReason: payload.updateReason ?? undefined,
      });
      continue;
    }

    if (canSms) {
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderTemplate(eventUpdateTemplate.smsBodyTemplate ?? '', variables),
        templateId: eventUpdateTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_updated',
        operationReason: payload.updateReason ?? undefined,
      });
    }
  }
}

function sendRsvpConfirmation(payload: RsvpNotificationPayload): void {
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
      operationType: 'rsvp_confirmation',
    });
  }

  if (payload.recipientPhone) {
    void notificationService.sendSms({
      to: payload.recipientPhone,
      message: renderTemplate(rsvpConfirmationTemplate.smsBodyTemplate ?? '', variables),
      templateId: rsvpConfirmationTemplate.templateId,
      memberId: payload.memberId,
      eventId: payload.eventId,
      operationType: 'rsvp_confirmation',
    });
  }

  if (!payload.recipientEmail && !payload.recipientPhone) {
    console.log('[STUB] sendRsvpConfirmation skipped (no recipient)', payload);
  }
}

async function sendWaitlistPromotionNotification(payload: WaitlistPromotionNotificationPayload): Promise<void> {
  const expiresAt = formatEventDate(payload.expires_at);
  const variables = {
    ...buildEventVariables(payload, payload.member_id),
    expiresAt,
  };

  const preferred = pickPreferredChannel(payload.preferredChannel);
  const canEmail = Boolean(payload.recipientEmail && !payload.emailOptOut);
  const canSms = Boolean(payload.recipientPhone && payload.smsOptIn);

  if (preferred === 'sms' && canSms) {
    await notificationService.sendSms({
      to: payload.recipientPhone as string,
      message: renderTemplate(waitlistPromotionTemplate.smsBodyTemplate ?? '', variables),
      templateId: waitlistPromotionTemplate.templateId,
      memberId: payload.member_id,
      eventId: payload.event_id,
      operationType: 'waitlist_promoted',
      operationReason: `Offer expires at ${expiresAt}`,
    });
    return;
  }

  if (canEmail) {
    await notificationService.sendEmail({
      to: payload.recipientEmail as string,
      subject: renderTemplate(waitlistPromotionTemplate.subjectTemplate ?? '', variables),
      htmlBody: renderTemplate(waitlistPromotionTemplate.htmlBodyTemplate ?? '', variables),
      textBody: renderTemplate(waitlistPromotionTemplate.textBodyTemplate ?? '', variables),
      templateId: waitlistPromotionTemplate.templateId,
      memberId: payload.member_id,
      eventId: payload.event_id,
      operationType: 'waitlist_promoted',
      operationReason: `Offer expires at ${expiresAt}`,
    });
    return;
  }

  if (canSms) {
    await notificationService.sendSms({
      to: payload.recipientPhone as string,
      message: renderTemplate(waitlistPromotionTemplate.smsBodyTemplate ?? '', variables),
      templateId: waitlistPromotionTemplate.templateId,
      memberId: payload.member_id,
      eventId: payload.event_id,
      operationType: 'waitlist_promoted',
      operationReason: `Offer expires at ${expiresAt}`,
    });
  }
}

function toNullableUuid(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const uuidV4Like = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidV4Like.test(value) ? value : null;
}

function buildEventVariables(
  payload: EventNotificationPayload,
  memberId?: string,
  groupContextId?: string
): Record<string, string> {
  const eventDate = formatEventDate(payload.event_date);
  const defaultRsvpUrl = `/events/${payload.event_id}`;
  let rsvpUrl = defaultRsvpUrl;
  let yesUrl = defaultRsvpUrl;
  let noUrl = defaultRsvpUrl;
  let maybeUrl = defaultRsvpUrl;
  let waitlistUrl = defaultRsvpUrl;

  if (memberId) {
    try {
      const personalizedUrls = buildMemberRsvpUrls(payload.event_id, memberId, groupContextId);
      rsvpUrl = personalizedUrls.landingUrl;
      yesUrl = personalizedUrls.yesUrl;
      noUrl = personalizedUrls.noUrl;
      maybeUrl = personalizedUrls.maybeUrl;
      waitlistUrl = personalizedUrls.waitlistUrl;
    } catch (error) {
      console.warn('[NotificationService] Failed to build personalized RSVP links; falling back to generic URL.', error);
    }
  }

  return {
    eventTitle: payload.title,
    eventDate,
    location: payload.location ?? 'TBD',
    description: payload.description ?? 'No additional details were provided.',
    rsvpUrl,
    yesUrl,
    noUrl,
    maybeUrl,
    waitlistUrl,
  };
}

function formatEventDate(value: Date | string): string {
  const dateValue = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(dateValue.getTime())) {
    return 'TBD';
  }

  return dateValue.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function truncateSms(message: string, limit = 160): string {
  if (message.length <= limit) {
    return message;
  }
  if (limit <= 3) {
    return '.'.repeat(Math.max(limit, 0));
  }
  return `${message.slice(0, limit - 3)}...`;
}

function pickPreferredChannel(responseChannel: string | null | undefined): 'email' | 'sms' {
  const normalized = responseChannel?.toLowerCase();
  if (!normalized) {
    return 'email';
  }
  if (normalized.includes('sms')) {
    return 'sms';
  }
  return 'email';
}

function summarizeChangedFields(changedFields: string[]): string {
  const labels: Record<string, string> = {
    title: 'title',
    description: 'description',
    location: 'location',
    event_date: 'event date/time',
    end_date: 'end time',
    capacity: 'capacity',
  };

  return changedFields
    .map((field) => labels[field] ?? field)
    .join(', ');
}

// ── TaVF notification stubs ────────────────────────────────────────────────────
// These are currently no-ops. Wire up real email/SMS sends when TAVF
// notification templates are created.

async function notifyNewPosting(_email: string, postingId: string): Promise<void> {
  const pool = await getPool();
  const postingResult = await pool
    .request()
    .input('posting_id', sql.UniqueIdentifier, postingId)
    .query<{ posting_id: string; location: string; event_date: Date }>(
      `SELECT posting_id, location, event_date
       FROM tavf_posting
       WHERE posting_id = @posting_id`
    );
  const posting = postingResult.recordset[0];
  if (!posting) {
    return;
  }

  const recipients = await pool
    .request()
    .query<{ email: string; member_id: string }>(
      `SELECT DISTINCT m.email, m.member_id
       FROM member m
       INNER JOIN member_group mg ON mg.member_id = m.member_id
       INNER JOIN [group] g ON g.group_id = mg.group_id
       WHERE g.group_name = 'ALL'
         AND m.is_active = 1
         AND (m.email_opt_out = 0 OR m.email_opt_out IS NULL)`
    );

  const eventDate = posting.event_date.toLocaleDateString();
  const subject = `New TAVF opportunity: ${posting.location} on ${eventDate}`;
  const body = `New TAVF opportunity: ${posting.location} on ${eventDate}. View: /tavf/${posting.posting_id}`;

  for (const recipient of recipients.recordset) {
    await notificationService.sendEmail({
      to: recipient.email,
      subject,
      htmlBody: `<p>${body}</p>`,
      textBody: body,
      memberId: recipient.member_id,
    });
  }
}

async function notifyApplicationReceived(_email: string, applicationId: string): Promise<void> {
  console.log(`[notifications] notifyApplicationReceived called for applicationId=${applicationId}`);
}

async function notifyMatchConfirmed(_guideEmail: string, matchId: string, _vetEmail: string): Promise<void> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('match_id', sql.UniqueIdentifier, matchId)
    .query<{
      posting_id: string;
      location: string;
      event_date: Date;
      guide_email: string;
      guide_member_id: string;
      vet_email: string;
      vet_member_id: string;
    }>(
      `SELECT
          p.posting_id,
          p.location,
          p.event_date,
          guide.email AS guide_email,
          guide.member_id AS guide_member_id,
          vet.email AS vet_email,
          vet.member_id AS vet_member_id
       FROM tavf_match tm
       INNER JOIN tavf_posting p ON p.posting_id = tm.posting_id
       INNER JOIN tavf_application ta ON ta.application_id = tm.application_id
       INNER JOIN member guide ON guide.member_id = p.guide_member_id
       INNER JOIN member vet ON vet.member_id = ta.vet_member_id
       WHERE tm.match_id = @match_id`
    );
  const row = result.recordset[0];
  if (!row) {
    return;
  }

  const dateLabel = row.event_date.toLocaleDateString();
  const subject = `TAVF Match Confirmed - ${row.location} on ${dateLabel}`;

  await notificationService.sendEmail({
    to: row.guide_email,
    subject,
    htmlBody: `<p>Your TAVF match is confirmed for ${row.location} on ${dateLabel}.</p>`,
    textBody: `Your TAVF match is confirmed for ${row.location} on ${dateLabel}.`,
    memberId: row.guide_member_id,
  });

  await notificationService.sendEmail({
    to: row.vet_email,
    subject,
    htmlBody: `<p>Your TAVF match is confirmed for ${row.location} on ${dateLabel}.</p>`,
    textBody: `Your TAVF match is confirmed for ${row.location} on ${dateLabel}.`,
    memberId: row.vet_member_id,
  });
}

async function notifyMatchCancelled(_guideEmail: string, matchId: string, _vetEmail: string): Promise<void> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('match_id', sql.UniqueIdentifier, matchId)
    .query<{
      location: string;
      event_date: Date;
      guide_email: string;
      guide_member_id: string;
      vet_email: string;
      vet_member_id: string;
    }>(
      `SELECT
          p.location,
          p.event_date,
          guide.email AS guide_email,
          guide.member_id AS guide_member_id,
          vet.email AS vet_email,
          vet.member_id AS vet_member_id
       FROM tavf_match tm
       INNER JOIN tavf_posting p ON p.posting_id = tm.posting_id
       INNER JOIN tavf_application ta ON ta.application_id = tm.application_id
       INNER JOIN member guide ON guide.member_id = p.guide_member_id
       INNER JOIN member vet ON vet.member_id = ta.vet_member_id
       WHERE tm.match_id = @match_id`
    );
  const row = result.recordset[0];
  if (!row) {
    return;
  }

  const dateLabel = row.event_date.toLocaleDateString();
  const subject = `TAVF Match Cancelled - ${row.location} on ${dateLabel}`;

  await notificationService.sendEmail({
    to: row.guide_email,
    subject,
    htmlBody: `<p>Your TAVF match for ${row.location} on ${dateLabel} has been cancelled.</p>`,
    textBody: `Your TAVF match for ${row.location} on ${dateLabel} has been cancelled.`,
    memberId: row.guide_member_id,
  });

  await notificationService.sendEmail({
    to: row.vet_email,
    subject,
    htmlBody: `<p>Your TAVF match for ${row.location} on ${dateLabel} has been cancelled.</p>`,
    textBody: `Your TAVF match for ${row.location} on ${dateLabel} has been cancelled.`,
    memberId: row.vet_member_id,
  });
}

export {
  NotificationService,
  NotificationConfigurationError,
  assertEventCancelledNotificationReady,
  assertEventPublishedNotificationReady,
  assertEventUpdatedNotificationReady,
  getNotificationRuntimeStatus,
  notifyApplicationReceived,
  notifyMatchCancelled,
  notifyMatchConfirmed,
  notifyNewPosting,
  AcsEmailService,
  AcsSmsService,
  sendEventCancelledNotification,
  sendEventPublishedNotification,
  sendEventUpdatedNotification,
  sendRsvpConfirmation,
  sendWaitlistPromotionNotification,
  StubEmailService,
  StubSmsService,
  notificationService,
};
export type {
  EventNotificationPayload,
  EventUpdateNotificationPayload,
  RsvpNotificationPayload,
  WaitlistPromotionNotificationPayload,
  SendEmailOptions,
  SendSmsOptions,
  IEmailService,
  ISmsService,
  NotificationChannel,
  NotificationStatus,
};