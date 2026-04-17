import { EmailClient } from '@azure/communication-email';
import { SmsClient } from '@azure/communication-sms';
import { getPool, sql } from '../db';
import twilio from 'twilio';
import { loadAcsConfig, loadTelnyxSmsConfig, loadTwilioSmsConfig } from '../config';
import { renderTemplate } from '../templates/NotificationTemplate';
import { eventCancellationTemplate } from '../templates/eventCancellation';
import { eventInviteTemplate } from '../templates/eventInvite';
import { eventThankYouTemplate } from '../templates/eventThankYou';
import { eventUpdateTemplate } from '../templates/eventUpdate';
import { rsvpConfirmationTemplate } from '../templates/rsvpConfirmation';
import { waitlistPromotionTemplate } from '../templates/waitlistPromotion';
import { buildMemberEmailUnsubscribeUrl } from './emailPreferenceLinkService';
import { buildMemberRsvpUrls, type ResponseRole } from './rsvpLinkService';
import { formatInProgramTimeZone } from '../utils/dateTime';

interface RsvpNotificationPayload {
  eventId: string;
  eventTitle: string;
  recipientEmail?: string;
  recipientPhone?: string;
  eventLeadEmail?: string;
  memberId?: string;
  firstName?: string;
  eventDate?: string;
  rsvpStatus?: string;
}

type NotificationChannel = 'email' | 'sms';
type NotificationStatus = 'stubbed' | 'failed' | 'sent' | 'skipped';
type NotificationMode = 'real' | 'partial' | 'stub';
type EmailPreferenceAction = 'opt_in' | 'opt_out';
type EmailPreferenceSource = 'link' | 'manual' | 'api' | 'system';
type EmailPreferenceOutcome = 'unsubscribed' | 'already_unsubscribed' | 'member_not_found' | 'invalid_token';

interface NotificationRuntimeStatus {
  mode: NotificationMode;
  strictModeEnabled: boolean;
  emailServiceMode: 'real' | 'stub';
  smsServiceMode: 'real' | 'stub';
  reasons: string[];
}

interface ProviderDeliveryStatusResult {
  provider_status: string | null;
  provider_error_detail: string | null;
  provider_checked_at: string;
  provider_source: 'acs_email';
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
  photo_url?: string | null;
  invitation_stage?: 'volunteer' | 'participant' | 'both' | null;
  event_lead_name?: string | null;
  event_lead_email?: string | null;
  updateReason?: string | null;
}

interface EventUpdateNotificationPayload extends EventNotificationPayload {
  changedFields: string[];
  changeSummary?: string | null;
  updateReason?: string | null;
}

const EVENT_PUBLISH_COOLDOWN_MINUTES = 30;

interface EventPublishSendOptions {
  targetGroupIds?: string[];
  skipCooldown?: boolean;
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

const tavfNewPostingTemplateName = 'TAVF New Posting';
const tavfApplicationReceivedTemplateName = 'TAVF Application Received';
const tavfMatchConfirmedTemplateName = 'TAVF Match Confirmed';
const tavfMatchCancelledTemplateName = 'TAVF Match Cancelled';

interface RuntimeTemplateOverride {
  subject: string | null;
  body: string;
}

interface SendEmailOptions {
  to: string;
  cc?: string[];
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
    private readonly senderAddress: string,
    private readonly toLineAddresses: string[]
  ) {
    this.client = new EmailClient(this.connectionString);
  }

  async sendEmail(options: SendEmailOptions): Promise<string | undefined> {
    // Send to actual recipient; optional: also BCC monitoring addresses if configured
    const toBccAddresses = this.toLineAddresses.filter((addr) => addr !== options.to);
    const bccRecipients = toBccAddresses.length > 0 ? toBccAddresses.map((address) => ({ address })) : undefined;
    const ccRecipients = (options.cc ?? [])
      .map((address) => address.trim())
      .filter(Boolean)
      .map((address) => ({ address }));

    const poller = await this.client.beginSend({
      senderAddress: this.senderAddress,
      content: {
        subject: options.subject,
        plainText: options.textBody,
        html: options.htmlBody,
      },
      recipients: {
        to: [{ address: options.to }],
        ...(ccRecipients.length > 0 ? { cc: ccRecipients } : {}),
        ...(bccRecipients && { bcc: bccRecipients }),
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

function parseToLineAddresses(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }

  const entries = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  return entries;
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

    // Azure SDK currently returns SmsSendResult[] directly, while older payloads
    // may still surface as { value: SmsSendResult[] }.
    const result = rawResult as Array<{ successful?: boolean; messageId?: string; errorMessage?: string }> | {
      value?: Array<{ successful?: boolean; messageId?: string; errorMessage?: string }>;
    };
    const recipients = Array.isArray(result)
      ? result
      : (Array.isArray(result.value) ? result.value : []);
    const firstRecipient = recipients[0];

    if (!firstRecipient) {
      throw new Error('ACS SMS send did not return recipient results.');
    }

    if (firstRecipient.successful === false) {
      throw new Error(`ACS SMS send failed: ${firstRecipient.errorMessage ?? 'Unknown error'}`);
    }

    return firstRecipient.messageId;
  }
}

class TwilioSmsService implements ISmsService {
  private readonly client: ReturnType<typeof twilio>;

  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
    private readonly messagingServiceSid: string
  ) {
    this.client = twilio(this.accountSid, this.authToken);
  }

  async sendSms(options: SendSmsOptions): Promise<string | undefined> {
    const result = await this.client.messages.create({
      to: options.to,
      body: options.message,
      messagingServiceSid: this.messagingServiceSid,
    }) as { sid?: string };

    if (!result?.sid) {
      throw new Error('Twilio SMS send did not return a message SID.');
    }

    return result.sid;
  }
}

class TelnyxSmsService implements ISmsService {
  constructor(
    private readonly apiKey: string,
    private readonly messagingProfileId?: string,
    private readonly fromNumber?: string
  ) {}

  async sendSms(options: SendSmsOptions): Promise<string | undefined> {
    const payload: Record<string, unknown> = {
      to: options.to,
      text: options.message,
    };

    if (this.messagingProfileId) {
      payload['messaging_profile_id'] = this.messagingProfileId;
    }

    if (this.fromNumber) {
      payload['from'] = this.fromNumber;
    }

    const response = await fetch('https://api.telnyx.com/v2/messages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const rawBody = await response.text();
    let parsed: unknown;
    try {
      parsed = rawBody ? JSON.parse(rawBody) : undefined;
    } catch {
      parsed = rawBody;
    }

    if (!response.ok) {
      throw new Error(`Telnyx SMS send failed (${response.status}): ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`);
    }

    const id = (parsed as { data?: { id?: string } } | undefined)?.data?.id;
    if (!id) {
      throw new Error('Telnyx SMS send did not return a message id.');
    }

    return id;
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
    const preparedOptions = this.appendEmailPreferenceFooter(options);

    try {
      providerId = await this.emailService.sendEmail(preparedOptions);
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

  private appendEmailPreferenceFooter(options: SendEmailOptions): SendEmailOptions {
    if (!options.memberId) {
      return options;
    }

    let unsubscribeUrl: string;
    try {
      unsubscribeUrl = buildMemberEmailUnsubscribeUrl(options.memberId, options.to);
    } catch (error) {
      console.warn('[NotificationService] Failed to build unsubscribe URL; sending email without preference footer.', error);
      return options;
    }

    const htmlFooter = `<hr style="border:none;border-top:1px solid #e5e7eb;margin-top:20px;margin-bottom:12px;" /><p style="font-size:12px;color:#6b7280;">To unsubscribe from PHW Alpine emails, <a href="${unsubscribeUrl}">click here</a>.</p>`;
    const textFooter = `\n\nTo unsubscribe from PHW Alpine emails: ${unsubscribeUrl}`;

    return {
      ...options,
      htmlBody: `${options.htmlBody}${htmlFooter}`,
      textBody: `${options.textBody ?? ''}${textFooter}`.trim(),
    };
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

  async writeNotificationAuditLog(entry: {
    channel: NotificationChannel;
    recipient: string;
    eventId?: string;
    memberId?: string;
    templateId?: string;
    operationType?: string;
    operationReason?: string;
    errorDetail?: string;
    status?: NotificationStatus;
  }): Promise<void> {
    await this.writeNotificationLog({
      channel: entry.channel,
      recipient: entry.recipient,
      status: entry.status ?? 'skipped',
      eventId: entry.eventId,
      memberId: entry.memberId,
      templateId: entry.templateId,
      operationType: entry.operationType,
      operationReason: entry.operationReason,
      errorDetail: entry.errorDetail,
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

  async writeEmailPreferenceLog(entry: {
    memberId?: string;
    recipientEmail?: string;
    action: EmailPreferenceAction;
    source: EmailPreferenceSource;
    outcome: EmailPreferenceOutcome;
    tokenExpiresAt?: string;
    notes?: string;
  }): Promise<void> {
    try {
      const pool = await getPool();
      const tokenExpiresAt = entry.tokenExpiresAt ? new Date(entry.tokenExpiresAt) : null;
      await pool
        .request()
        .input('member_id', sql.UniqueIdentifier, toNullableUuid(entry.memberId))
        .input('recipient_email', sql.NVarChar(255), entry.recipientEmail ?? null)
        .input('action', sql.NVarChar(20), entry.action)
        .input('source', sql.NVarChar(20), entry.source)
        .input('outcome', sql.NVarChar(30), entry.outcome)
        .input('token_expires_at', sql.DateTime, tokenExpiresAt)
        .input('notes', sql.NVarChar(500), entry.notes ?? null)
        .query(
          `INSERT INTO email_preference_log (
              email_preference_log_id,
              member_id,
              recipient_email,
              action,
              source,
              outcome,
              token_expires_at,
              notes,
              recorded_at
           )
           VALUES (
              NEWID(),
              @member_id,
              @recipient_email,
              @action,
              @source,
              @outcome,
              @token_expires_at,
              @notes,
              GETUTCDATE()
           )`
        );
    } catch (error) {
      console.error('[NotificationService] Failed to write email_preference_log', error);
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

function stripHtmlToText(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getActiveTemplateOverride(templateName: string, channel: 'email' | 'sms'): Promise<RuntimeTemplateOverride | null> {
  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('template_name', sql.NVarChar(100), templateName)
      .input('channel', sql.NVarChar(10), channel)
      .query<{ subject: string | null; body: string }>(
        `SELECT TOP 1 subject, body
         FROM notification_template
         WHERE template_name = @template_name
           AND channel = @channel
           AND is_active = 1
         ORDER BY updated_at DESC`
      );

    const row = result.recordset[0];
    return row ? { subject: row.subject, body: row.body } : null;
  } catch (error) {
    console.warn('[NotificationService] Failed to load runtime template override, using built-in template.', {
      templateName,
      channel,
      error,
    });
    return null;
  }
}

function renderEmailTemplate(
  override: RuntimeTemplateOverride | null,
  fallback: { subject: string; htmlBody: string; textBody: string },
  variables: Record<string, string>
): { subject: string; htmlBody: string; textBody: string } {
  if (!override) {
    return {
      subject: renderTemplate(fallback.subject, variables),
      htmlBody: renderTemplate(fallback.htmlBody, variables),
      textBody: renderTemplate(fallback.textBody, variables),
    };
  }

  const renderedHtmlBody = renderTemplate(override.body, variables);
  const subjectSource = override.subject && override.subject.trim().length > 0
    ? override.subject
    : fallback.subject;

  return {
    subject: renderTemplate(subjectSource, variables),
    htmlBody: renderedHtmlBody,
    textBody: stripHtmlToText(renderedHtmlBody),
  };
}

function renderSmsTemplate(override: RuntimeTemplateOverride | null, fallbackBody: string, variables: Record<string, string>): string {
  return renderTemplate(override?.body ?? fallbackBody, variables);
}

const acsConfig = loadAcsConfig();
const telnyxSmsConfig = loadTelnyxSmsConfig();
const twilioSmsConfig = loadTwilioSmsConfig();
let emailService: IEmailService = new StubEmailService();
let smsService: ISmsService = new StubSmsService();
let isRealEmailService = false;
let isRealSmsService = false;
let acsEmailStatusClient: EmailClient | null = null;
const notificationInitReasons: string[] = [];
const hasValidAcsConnectionString = Boolean(
  acsConfig.connectionString &&
    /endpoint\s*=\s*https?:\/\//i.test(acsConfig.connectionString) &&
    /accesskey\s*=/i.test(acsConfig.connectionString)
);

const strictModeEnabled = /^(1|true|yes|on)$/i.test(process.env['NOTIFICATIONS_STRICT_MODE'] ?? '');

if (!acsConfig.connectionString || !acsConfig.emailFrom) {
  notificationInitReasons.push('ACS email configuration is incomplete (connection string or email sender missing).');
  console.warn('[NotificationService] ACS email is not configured. Email sends are running in stub mode.');
} else if (!hasValidAcsConnectionString) {
  notificationInitReasons.push('ACS email connection string is invalid.');
  console.warn('[NotificationService] ACS connection string appears invalid. Email sends are running in stub mode.');
} else {
  try {
    const toLineAddresses = parseToLineAddresses(acsConfig.emailTo);
    emailService = new AcsEmailService(acsConfig.connectionString ?? '', acsConfig.emailFrom ?? '', toLineAddresses);
    isRealEmailService = true;
  } catch (error) {
    notificationInitReasons.push('Failed to initialize ACS email client.');
    console.warn('[NotificationService] Failed to initialize ACS email client, falling back to stub mode.', error);
  }
}

if (telnyxSmsConfig.isConfigured) {
  try {
    smsService = new TelnyxSmsService(
      telnyxSmsConfig.apiKey ?? '',
      telnyxSmsConfig.messagingProfileId,
      telnyxSmsConfig.fromNumber
    );
    isRealSmsService = true;
  } catch (error) {
    notificationInitReasons.push('Failed to initialize Telnyx SMS client.');
    console.warn('[NotificationService] Failed to initialize Telnyx SMS client, attempting fallback providers.', error);
  }
}

if (!isRealSmsService && twilioSmsConfig.isConfigured) {
  try {
    smsService = new TwilioSmsService(
      twilioSmsConfig.accountSid ?? '',
      twilioSmsConfig.authToken ?? '',
      twilioSmsConfig.messagingServiceSid ?? ''
    );
    isRealSmsService = true;
  } catch (error) {
    notificationInitReasons.push('Failed to initialize Twilio SMS client.');
    console.warn('[NotificationService] Failed to initialize Twilio SMS client, falling back to stub mode.', error);
  }
}

if (!isRealSmsService) {
  if (acsConfig.smsFrom) {
    notificationInitReasons.push('ACS SMS configuration detected but ACS SMS is disabled. Configure Telnyx or Twilio credentials to send SMS.');
  } else {
    notificationInitReasons.push('No SMS provider configured. Set TELNYX_API_KEY with TELNYX_MESSAGING_PROFILE_ID/TELNYX_FROM_NUMBER, or Twilio credentials.');
  }
  console.warn('[NotificationService] No SMS provider is configured. SMS sends are running in stub mode.');
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
      `Notification channel unavailable for ${context}: email delivery is required but email provider is not configured.`
    );
  }

  if (channels.smsNeeded && !isRealSmsService) {
    throw new NotificationConfigurationError(
      `Notification channel unavailable for ${context}: SMS delivery is required but no SMS provider is configured.`
    );
  }
}

function getAcsEmailStatusClient(): EmailClient | null {
  if (!acsConfig.isConfigured || !hasValidAcsConnectionString) {
    return null;
  }

  if (!acsEmailStatusClient) {
    acsEmailStatusClient = new EmailClient(acsConfig.connectionString ?? '');
  }

  return acsEmailStatusClient;
}

async function getAcsEmailProviderDeliveryStatus(providerId: string): Promise<ProviderDeliveryStatusResult> {
  const checkedAt = new Date().toISOString();
  const trimmedProviderId = providerId.trim();
  if (!trimmedProviderId) {
    return {
      provider_status: null,
      provider_error_detail: 'Missing provider_id.',
      provider_checked_at: checkedAt,
      provider_source: 'acs_email',
    };
  }

  const client = getAcsEmailStatusClient();
  if (!client) {
    return {
      provider_status: null,
      provider_error_detail: 'ACS email provider client is not configured.',
      provider_checked_at: checkedAt,
      provider_source: 'acs_email',
    };
  }

  try {
    const internalClient = (client as unknown as {
      generatedClient?: {
        email?: {
          getSendResult?: (operationId: string) => Promise<{ status?: string; error?: { message?: string } | string }>;
        };
      };
    }).generatedClient;

    if (!internalClient?.email?.getSendResult) {
      return {
        provider_status: null,
        provider_error_detail: 'Installed @azure/communication-email SDK does not expose getSendResult.',
        provider_checked_at: checkedAt,
        provider_source: 'acs_email',
      };
    }

    const result = (await internalClient.email.getSendResult(trimmedProviderId)) as {
      status?: string;
      error?: { message?: string } | string;
    };
    const providerError = typeof result?.error === 'string'
      ? result.error
      : result?.error?.message;

    return {
      provider_status: result?.status ?? null,
      provider_error_detail: providerError ?? null,
      provider_checked_at: checkedAt,
      provider_source: 'acs_email',
    };
  } catch (error) {
    return {
      provider_status: null,
      provider_error_detail: error instanceof Error ? error.message : String(error),
      provider_checked_at: checkedAt,
      provider_source: 'acs_email',
    };
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

async function hasRecentPublishedNotification(eventId: string, cooldownMinutes: number): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, eventId)
    .input('cooldown_minutes', sql.Int, cooldownMinutes)
    .query<{ hit_count: number }>(
      `SELECT COUNT(*) AS hit_count
       FROM notification_log
       WHERE event_id = @event_id
         AND operation_type = 'event_published'
         AND status IN ('sent', 'delivered', 'stubbed')
         AND sent_at >= DATEADD(MINUTE, -@cooldown_minutes, GETUTCDATE())`
    );

  return (result.recordset[0]?.hit_count ?? 0) > 0;
}

async function sendEventPublishedNotification(
  payload: EventNotificationPayload,
  options: EventPublishSendOptions = {}
): Promise<void> {
  if (!options.skipCooldown && await hasRecentPublishedNotification(payload.event_id, EVENT_PUBLISH_COOLDOWN_MINUTES)) {
    console.warn('[NotificationService] Skipping event_published send due to cooldown window', {
      eventId: payload.event_id,
      cooldownMinutes: EVENT_PUBLISH_COOLDOWN_MINUTES,
    });
    return;
  }

  await assertEventPublishedNotificationReady(payload.event_id);

  const [emailTemplateOverride, smsTemplateOverride] = await Promise.all([
    getActiveTemplateOverride(eventInviteTemplate.displayName, 'email'),
    getActiveTemplateOverride(eventInviteTemplate.displayName, 'sms'),
  ]);

  const requestedTargetGroupIds = Array.from(
    new Set((options.targetGroupIds ?? []).map((id) => id.trim()).filter(Boolean))
  );

  const pool = await getPool();
  const recipientsRequest = pool
    .request()
    .input('event_id', sql.UniqueIdentifier, payload.event_id);
  const targetGroupPredicate = requestedTargetGroupIds.length > 0
    ? requestedTargetGroupIds.map((_id, idx) => {
      const param = `target_group_id_${idx}`;
      recipientsRequest.input(param, sql.UniqueIdentifier, requestedTargetGroupIds[idx]);
      return `@${param}`;
    }).join(', ')
    : null;
  const recipientsResult = await recipientsRequest.query<{
      member_id: string;
      group_context_id: string | null;
      group_name: string | null;
      first_name: string | null;
      email: string;
      mobile_phone: string | null;
      sms_opt_in: boolean;
      email_opt_out: boolean;
    }>(
      `SELECT
          m.member_id,
          ent.group_id AS group_context_id,
          g.group_name,
          m.first_name,
          m.email,
          m.mobile_phone,
          m.sms_opt_in,
          m.email_opt_out
       FROM event_notification_target ent
       LEFT JOIN member_group mg ON mg.group_id = ent.group_id
       LEFT JOIN [group] g ON g.group_id = ent.group_id
       LEFT JOIN member m ON m.member_id = COALESCE(ent.member_id, mg.member_id)
       WHERE ent.event_id = @event_id
          ${targetGroupPredicate ? `AND ent.group_id IN (${targetGroupPredicate})` : ''}
         AND m.member_id IS NOT NULL`
      );

  let sentEmailCount = 0;
  let sentSmsCount = 0;
  let skippedCount = 0;
  const skipReasonCounts: Record<string, number> = {};

  const recordSkip = async (
    recipient: {
      member_id: string;
      email: string;
      mobile_phone: string | null;
    },
    reason: string,
    detail: string
  ): Promise<void> => {
    skippedCount += 1;
    skipReasonCounts[reason] = (skipReasonCounts[reason] ?? 0) + 1;
    const recipientValue = recipient.email?.trim() || recipient.mobile_phone?.trim() || `member:${recipient.member_id}`;
    const channel: NotificationChannel = recipient.email?.trim() ? 'email' : 'sms';
    await notificationService.writeNotificationAuditLog({
      channel,
      recipient: recipientValue,
      eventId: payload.event_id,
      memberId: recipient.member_id,
      templateId: eventInviteTemplate.templateId,
      operationType: 'event_published',
      operationReason: `skip:${reason}`,
      errorDetail: detail,
      status: 'skipped',
    });
  };

  for (const recipient of recipientsResult.recordset) {
    const inferredRole = inferRoleFromGroupName(recipient.group_name);
    if (payload.invitation_stage === 'volunteer' && inferredRole !== 'MENTOR') {
      await recordSkip(recipient, 'role_filter', 'Invitation stage is volunteer; recipient role is not mentor.');
      continue;
    }
    if (payload.invitation_stage === 'participant' && inferredRole !== 'PARTICIPANT') {
      await recordSkip(recipient, 'role_filter', 'Invitation stage is participant; recipient role is not participant.');
      continue;
    }

    const canEmail = Boolean(!recipient.email_opt_out && recipient.email);
    const canSms = Boolean(recipient.mobile_phone && recipient.sms_opt_in);
    if (!canEmail && !canSms) {
      await recordSkip(
        recipient,
        'no_eligible_channel',
        'Recipient has no eligible delivery channel (email opted out/missing and SMS not opted in or missing phone).'
      );
      continue;
    }

    const variables = buildEventVariables(
      payload,
      recipient.member_id,
      recipient.group_context_id ?? undefined,
      inferredRole
    );
    if (canEmail) {
      const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
        subject: eventInviteTemplate.subjectTemplate ?? '',
        htmlBody: eventInviteTemplate.htmlBodyTemplate ?? '',
        textBody: eventInviteTemplate.textBodyTemplate ?? '',
      }, variables);
      await notificationService.sendEmail({
        to: recipient.email,
        subject: renderedEmail.subject,
        htmlBody: renderedEmail.htmlBody,
        textBody: renderedEmail.textBody,
        templateId: eventInviteTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_published',
      });
      sentEmailCount += 1;
    }

    if (canSms) {
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderSmsTemplate(smsTemplateOverride, eventInviteTemplate.smsBodyTemplate ?? '', variables),
        templateId: eventInviteTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_published',
      });
      sentSmsCount += 1;
    }
  }

  const skipSummary = Object.entries(skipReasonCounts)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason}:${count}`)
    .join(', ');

  await sendCoordinatorSummaryEmail({
    eventLeadEmail: payload.event_lead_email,
    eventId: payload.event_id,
    subject: `Coordinator summary: invites sent for ${payload.title}`,
    lines: [
      `Event: ${payload.title}`,
      `Date/time: ${formatEventDate(payload.event_date)}`,
      `Location: ${payload.location ?? 'TBD'}`,
      `Invitation stage: ${payload.invitation_stage ?? 'both'}`,
      `Email recipients sent: ${sentEmailCount}`,
      `SMS recipients sent: ${sentSmsCount}`,
      `Recipients skipped: ${skippedCount}`,
      `Skip reasons: ${skipSummary || 'none'}`,
    ],
    operationType: 'event_published',
  });
}

async function sendEventCancelledNotification(payload: EventNotificationPayload): Promise<void> {
  await assertEventCancelledNotificationReady(payload.event_id);

  const [emailTemplateOverride, smsTemplateOverride] = await Promise.all([
    getActiveTemplateOverride(eventCancellationTemplate.displayName, 'email'),
    getActiveTemplateOverride(eventCancellationTemplate.displayName, 'sms'),
  ]);

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
        message: renderSmsTemplate(smsTemplateOverride, eventCancellationTemplate.smsBodyTemplate ?? '', variables),
        templateId: eventCancellationTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_cancelled',
        operationReason: payload.updateReason ?? undefined,
      });
      continue;
    }

    if (canEmail) {
      const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
        subject: eventCancellationTemplate.subjectTemplate ?? '',
        htmlBody: eventCancellationTemplate.htmlBodyTemplate ?? '',
        textBody: eventCancellationTemplate.textBodyTemplate ?? '',
      }, variables);
      await notificationService.sendEmail({
        to: recipient.email,
        cc: buildEventLeadCc(payload.event_lead_email, recipient.email),
        subject: renderedEmail.subject,
        htmlBody: renderedEmail.htmlBody,
        textBody: renderedEmail.textBody,
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
        message: renderSmsTemplate(smsTemplateOverride, eventCancellationTemplate.smsBodyTemplate ?? '', variables),
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

  const [emailTemplateOverride, smsTemplateOverride] = await Promise.all([
    getActiveTemplateOverride(eventUpdateTemplate.displayName, 'email'),
    getActiveTemplateOverride(eventUpdateTemplate.displayName, 'sms'),
  ]);

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

  const changeSummary = payload.changeSummary?.trim() || summarizeChangedFields(payload.changedFields);
  let sentEmailCount = 0;
  let sentSmsCount = 0;

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
        message: renderSmsTemplate(smsTemplateOverride, eventUpdateTemplate.smsBodyTemplate ?? '', variables),
        templateId: eventUpdateTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_updated',
        operationReason: payload.updateReason ?? undefined,
      });
      sentSmsCount += 1;
      continue;
    }

    if (canEmail) {
      const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
        subject: eventUpdateTemplate.subjectTemplate ?? '',
        htmlBody: eventUpdateTemplate.htmlBodyTemplate ?? '',
        textBody: eventUpdateTemplate.textBodyTemplate ?? '',
      }, variables);
      await notificationService.sendEmail({
        to: recipient.email,
        subject: renderedEmail.subject,
        htmlBody: renderedEmail.htmlBody,
        textBody: renderedEmail.textBody,
        templateId: eventUpdateTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_updated',
        operationReason: payload.updateReason ?? undefined,
      });
      sentEmailCount += 1;
      continue;
    }

    if (canSms) {
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderSmsTemplate(smsTemplateOverride, eventUpdateTemplate.smsBodyTemplate ?? '', variables),
        templateId: eventUpdateTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_updated',
        operationReason: payload.updateReason ?? undefined,
      });
      sentSmsCount += 1;
    }
  }

  await sendCoordinatorSummaryEmail({
    eventLeadEmail: payload.event_lead_email,
    eventId: payload.event_id,
    subject: `Coordinator summary: update sent for ${payload.title}`,
    lines: [
      `Event: ${payload.title}`,
      `Date/time: ${formatEventDate(payload.event_date)}`,
      `Location: ${payload.location ?? 'TBD'}`,
      `Change summary: ${changeSummary}`,
      `Update reason: ${payload.updateReason?.trim() || 'Not provided'}`,
      `Email recipients sent: ${sentEmailCount}`,
      `SMS recipients sent: ${sentSmsCount}`,
    ],
    operationType: 'event_updated',
  });
}

async function sendEventCompletedNotification(payload: EventNotificationPayload): Promise<void> {
  const [emailTemplateOverride, smsTemplateOverride] = await Promise.all([
    getActiveTemplateOverride(eventThankYouTemplate.displayName, 'email'),
    getActiveTemplateOverride(eventThankYouTemplate.displayName, 'sms'),
  ]);

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
      `WITH ranked_attendees AS (
          SELECT
            ea.member_id,
            ROW_NUMBER() OVER (PARTITION BY ea.member_id ORDER BY ea.assigned_at DESC) AS rn
          FROM event_assignment ea
          WHERE ea.event_id = @event_id
            AND ea.attended = 1
      )
      SELECT DISTINCT
          m.member_id,
          m.first_name,
          m.email,
          m.mobile_phone,
          m.sms_opt_in,
          m.email_opt_out,
          er.response_channel
      FROM ranked_attendees ra
      INNER JOIN member m ON m.member_id = ra.member_id
      LEFT JOIN event_response er ON er.event_id = @event_id AND er.member_id = m.member_id
      WHERE ra.rn = 1`
    );

  for (const recipient of recipientsResult.recordset) {
    const variables = {
      ...buildEventVariables(payload, recipient.member_id),
      firstName: recipient.first_name?.trim() || 'friend',
    };
    const preferredChannel = pickPreferredChannel(recipient.response_channel);
    const canEmail = Boolean(!recipient.email_opt_out && recipient.email);
    const canSms = Boolean(recipient.mobile_phone && recipient.sms_opt_in);

    if (preferredChannel === 'sms' && canSms) {
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderSmsTemplate(smsTemplateOverride, eventThankYouTemplate.smsBodyTemplate ?? '', variables),
        templateId: eventThankYouTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_completed',
      });
      continue;
    }

    if (canEmail) {
      const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
        subject: eventThankYouTemplate.subjectTemplate ?? '',
        htmlBody: eventThankYouTemplate.htmlBodyTemplate ?? '',
        textBody: eventThankYouTemplate.textBodyTemplate ?? '',
      }, variables);
      await notificationService.sendEmail({
        to: recipient.email,
        cc: buildEventLeadCc(payload.event_lead_email, recipient.email),
        subject: renderedEmail.subject,
        htmlBody: renderedEmail.htmlBody,
        textBody: renderedEmail.textBody,
        templateId: eventThankYouTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_completed',
      });
      continue;
    }

    if (canSms) {
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderSmsTemplate(smsTemplateOverride, eventThankYouTemplate.smsBodyTemplate ?? '', variables),
        templateId: eventThankYouTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_completed',
      });
    }
  }
}

function sendRsvpConfirmation(payload: RsvpNotificationPayload): void {
  void (async () => {
    const variables = {
      firstName: payload.firstName ?? 'Member',
      eventName: payload.eventTitle,
      eventDate: payload.eventDate ?? 'TBD',
      rsvpStatus: payload.rsvpStatus ?? 'confirmed',
    };

    if (!payload.recipientEmail && !payload.recipientPhone) {
      console.log('[STUB] sendRsvpConfirmation skipped (no recipient)', payload);
      return;
    }

    const useRuntimeOverrides = process.env.NODE_ENV !== 'test';
    const [emailTemplateOverride, smsTemplateOverride] = useRuntimeOverrides
      ? await Promise.all([
          getActiveTemplateOverride(rsvpConfirmationTemplate.displayName, 'email'),
          getActiveTemplateOverride(rsvpConfirmationTemplate.displayName, 'sms'),
        ])
      : [null, null];

    if (payload.recipientEmail) {
      const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
        subject: rsvpConfirmationTemplate.subjectTemplate ?? '',
        htmlBody: rsvpConfirmationTemplate.htmlBodyTemplate ?? '',
        textBody: rsvpConfirmationTemplate.textBodyTemplate ?? '',
      }, variables);
      const coordinatorCc = shouldCcCoordinatorForRsvp(payload.rsvpStatus)
        ? buildEventLeadCc(payload.eventLeadEmail, payload.recipientEmail)
        : [];
      await notificationService.sendEmail({
        to: payload.recipientEmail,
        cc: coordinatorCc,
        subject: renderedEmail.subject,
        htmlBody: renderedEmail.htmlBody,
        textBody: renderedEmail.textBody,
        templateId: rsvpConfirmationTemplate.templateId,
        memberId: payload.memberId,
        eventId: payload.eventId,
        operationType: 'rsvp_confirmation',
      });
    }

    if (payload.recipientPhone) {
      await notificationService.sendSms({
        to: payload.recipientPhone,
        message: renderSmsTemplate(smsTemplateOverride, rsvpConfirmationTemplate.smsBodyTemplate ?? '', variables),
        templateId: rsvpConfirmationTemplate.templateId,
        memberId: payload.memberId,
        eventId: payload.eventId,
        operationType: 'rsvp_confirmation',
      });
    }
  })().catch((error) => {
    console.error('[NotificationService] Failed to send RSVP confirmation', {
      memberId: payload.memberId,
      eventId: payload.eventId,
      error,
    });
  });
}

async function sendWaitlistPromotionNotification(payload: WaitlistPromotionNotificationPayload): Promise<void> {
  const [emailTemplateOverride, smsTemplateOverride] = await Promise.all([
    getActiveTemplateOverride(waitlistPromotionTemplate.displayName, 'email'),
    getActiveTemplateOverride(waitlistPromotionTemplate.displayName, 'sms'),
  ]);

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
      message: renderSmsTemplate(smsTemplateOverride, waitlistPromotionTemplate.smsBodyTemplate ?? '', variables),
      templateId: waitlistPromotionTemplate.templateId,
      memberId: payload.member_id,
      eventId: payload.event_id,
      operationType: 'waitlist_promoted',
      operationReason: `Offer expires at ${expiresAt}`,
    });
    return;
  }

  if (canEmail) {
    const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
      subject: waitlistPromotionTemplate.subjectTemplate ?? '',
      htmlBody: waitlistPromotionTemplate.htmlBodyTemplate ?? '',
      textBody: waitlistPromotionTemplate.textBodyTemplate ?? '',
    }, variables);
    await notificationService.sendEmail({
      to: payload.recipientEmail as string,
      subject: renderedEmail.subject,
      htmlBody: renderedEmail.htmlBody,
      textBody: renderedEmail.textBody,
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
      message: renderSmsTemplate(smsTemplateOverride, waitlistPromotionTemplate.smsBodyTemplate ?? '', variables),
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
  groupContextId?: string,
  preferredRole?: ResponseRole
): Record<string, string> {
  const eventDate = formatEventDate(payload.event_date);
  const normalizedLocation = payload.location?.trim() || 'TBD';
  const mapUrl = normalizedLocation !== 'TBD'
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(normalizedLocation)}`
    : '';
  const photoUrl = payload.photo_url?.trim() || '';
  const eventLeadName = payload.event_lead_name?.trim() || '';
  const eventLeadEmail = payload.event_lead_email?.trim() || '';
  const mapSection = mapUrl
    ? `<p style="margin:8px 0 0;"><strong>Map:</strong> <a href="${mapUrl}" style="color:#1456cc;text-decoration:underline;">View on Google Maps</a></p>`
    : '';
  const photoSection = photoUrl
    ? `<tr><td style="padding:0 0 16px;"><img src="${photoUrl}" alt="${payload.title}" style="display:block;width:100%;max-width:608px;height:auto;border-radius:14px;border:1px solid #d7e3f4;" /></td></tr>`
    : '';
  const eventLeadSection = (eventLeadName || eventLeadEmail)
    ? `<p style="margin:10px 0 0;color:#1f3b6e;font-size:14px;"><strong>Coordinator:</strong> ${eventLeadName || 'PHW Alpine Team'}${eventLeadEmail ? ` · <a href=\"mailto:${eventLeadEmail}\" style=\"color:#1456cc;text-decoration:underline;\">${eventLeadEmail}</a>` : ''}</p>`
    : '';
  const defaultRsvpUrl = `/events/${payload.event_id}`;
  let rsvpUrl = defaultRsvpUrl;
  let yesUrl = defaultRsvpUrl;
  let noUrl = defaultRsvpUrl;
  let maybeUrl = defaultRsvpUrl;
  let waitlistUrl = defaultRsvpUrl;
  const replyAddress = process.env['ACS_EMAIL_FROM'] || 'Scheduler@mail.phwcoloradoalpine.org';
  const createReplyMailto = (response: 'YES' | 'NO' | 'MAYBE' | 'WAITLIST'): string => {
    const subject = `RSVP ${response} - ${payload.title}`;
    const body = [
      `Response: ${response}`,
      `Event: ${payload.title}`,
      `Event ID: ${payload.event_id}`,
      memberId ? `Member ID: ${memberId}` : '',
      groupContextId ? `Group Context ID: ${groupContextId}` : '',
    ].filter(Boolean).join('\n');
    return `mailto:${replyAddress}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  };

  if (memberId) {
    try {
      const personalizedUrls = buildMemberRsvpUrls(payload.event_id, memberId, groupContextId, preferredRole);
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
    location: normalizedLocation,
    description: payload.description ?? 'No additional details were provided.',
    eventPhotoUrl: photoUrl,
    mapUrl,
    mapSection,
    photoSection,
    eventLeadName,
    eventLeadEmail,
    eventLeadSection,
    rsvpUrl,
    yesUrl,
    noUrl,
    maybeUrl,
    waitlistUrl,
    replyYesMailto: createReplyMailto('YES'),
    replyNoMailto: createReplyMailto('NO'),
    replyMaybeMailto: createReplyMailto('MAYBE'),
    replyWaitlistMailto: createReplyMailto('WAITLIST'),
  };
}

function inferRoleFromGroupName(groupName: string | null): ResponseRole | undefined {
  if (!groupName) {
    return undefined;
  }

  const normalized = groupName.toUpperCase();
  if (normalized.includes('MENTOR') || normalized.includes('VOLUNTEER')) {
    return 'MENTOR';
  }
  if (normalized.includes('PARTICIPANT') || normalized.includes('VETERAN') || normalized.includes('VET')) {
    return 'PARTICIPANT';
  }

  return undefined;
}

function buildEventLeadCc(eventLeadEmail: string | null | undefined, recipientEmail: string): string[] {
  if (!eventLeadEmail) {
    return [];
  }

  const normalizedLead = eventLeadEmail.trim().toLowerCase();
  const normalizedRecipient = recipientEmail.trim().toLowerCase();
  if (!normalizedLead || normalizedLead === normalizedRecipient) {
    return [];
  }

  return [normalizedLead];
}

function shouldCcCoordinatorForRsvp(rsvpStatus: string | undefined): boolean {
  if (!rsvpStatus) {
    return false;
  }
  const normalized = rsvpStatus.trim().toLowerCase();
  return normalized === 'yes' || normalized === 'confirmed_yes';
}

async function sendCoordinatorSummaryEmail(options: {
  eventLeadEmail?: string | null;
  eventId: string;
  subject: string;
  lines: string[];
  operationType: 'event_published' | 'event_updated';
}): Promise<void> {
  const to = options.eventLeadEmail?.trim().toLowerCase();
  if (!to) {
    return;
  }

  const textBody = options.lines.join('\n');
  const htmlBody = `<div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#1f2937;">${options.lines
    .map((line) => `<p style="margin:0 0 8px;">${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
    .join('')}</div>`;

  await notificationService.sendEmail({
    to,
    subject: options.subject,
    htmlBody,
    textBody,
    eventId: options.eventId,
    operationType: options.operationType,
    operationReason: 'coordinator_summary',
  });
}

function formatEventDate(value: Date | string): string {
  return formatInProgramTimeZone(value);
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
    mentor_capacity: 'volunteer capacity',
    participant_capacity: 'participant capacity',
    capacity: 'capacity',
  };

  return changedFields
    .map((field) => labels[field] ?? field)
    .join(', ');
}

async function notifyNewPosting(postingId: string): Promise<void> {
  const pool = await getPool();
  const [emailTemplateOverride, smsTemplateOverride] = await Promise.all([
    getActiveTemplateOverride(tavfNewPostingTemplateName, 'email'),
    getActiveTemplateOverride(tavfNewPostingTemplateName, 'sms'),
  ]);

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
    .request();

  let recipientRows: Array<{
    email: string;
    member_id: string;
    mobile_phone: string | null;
    sms_opt_in: boolean;
    email_opt_out: boolean;
  }> = [];

  try {
    const subscribedRecipients = await recipients.query<{ email: string; member_id: string; mobile_phone: string | null; sms_opt_in: boolean; email_opt_out: boolean }>(
      `SELECT DISTINCT m.email, m.member_id, m.mobile_phone, m.sms_opt_in, m.email_opt_out
       FROM member m
       INNER JOIN tavf_notification_subscription tns ON tns.member_id = m.member_id
       WHERE m.is_active = 1
         AND tns.is_subscribed = 1
         AND ((m.email_opt_out = 0 OR m.email_opt_out IS NULL) OR (m.sms_opt_in = 1 AND m.mobile_phone IS NOT NULL))`
    );
    recipientRows = subscribedRecipients.recordset;
  } catch (subscriptionError) {
    console.warn('[NotificationService] tavf_notification_subscription not available, using ALL-group fallback.', subscriptionError);
    const fallbackRecipients = await pool
      .request()
      .query<{ email: string; member_id: string; mobile_phone: string | null; sms_opt_in: boolean; email_opt_out: boolean }>(
        `SELECT DISTINCT m.email, m.member_id, m.mobile_phone, m.sms_opt_in, m.email_opt_out
         FROM member m
         INNER JOIN member_group mg ON mg.member_id = m.member_id
         INNER JOIN [group] g ON g.group_id = mg.group_id
         WHERE g.group_name = 'ALL'
           AND m.is_active = 1
           AND ((m.email_opt_out = 0 OR m.email_opt_out IS NULL) OR (m.sms_opt_in = 1 AND m.mobile_phone IS NOT NULL))`
      );
    recipientRows = fallbackRecipients.recordset;
  }

  const eventDate = posting.event_date.toLocaleDateString();
  const variables = {
    location: posting.location,
    eventDate,
    postingUrl: `/tavf/${posting.posting_id}`,
  };
  const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
    subject: 'New TAVF opportunity: {{location}} on {{eventDate}}',
    htmlBody: '<p>New TAVF opportunity: {{location}} on {{eventDate}}. View: {{postingUrl}}</p>',
    textBody: 'New TAVF opportunity: {{location}} on {{eventDate}}. View: {{postingUrl}}',
  }, variables);
  const renderedSms = renderSmsTemplate(
    smsTemplateOverride,
    'PHW Alpine TAVF: New opportunity at {{location}} on {{eventDate}}. Open app for details. Reply STOP to opt out.',
    variables
  );

  for (const recipient of recipientRows) {
    if (recipient.email && !recipient.email_opt_out) {
      await notificationService.sendEmail({
        to: recipient.email,
        subject: renderedEmail.subject,
        htmlBody: renderedEmail.htmlBody,
        textBody: renderedEmail.textBody,
        memberId: recipient.member_id,
        operationType: 'tavf_new_posting',
      });
    }

    if (recipient.sms_opt_in && recipient.mobile_phone) {
      await notificationService.sendSms({
        to: recipient.mobile_phone,
        message: renderedSms,
        memberId: recipient.member_id,
        operationType: 'tavf_new_posting',
      });
    }
  }
}

async function notifyApplicationReceived(applicationId: string): Promise<void> {
  const pool = await getPool();
  const [emailTemplateOverride, smsTemplateOverride] = await Promise.all([
    getActiveTemplateOverride(tavfApplicationReceivedTemplateName, 'email'),
    getActiveTemplateOverride(tavfApplicationReceivedTemplateName, 'sms'),
  ]);

  const result = await pool
    .request()
    .input('application_id', sql.UniqueIdentifier, applicationId)
    .query<{
      location: string;
      event_date: Date;
      guide_email: string;
      guide_member_id: string;
      guide_mobile_phone: string | null;
      guide_sms_opt_in: boolean;
      vet_first_name: string | null;
    }>(
      `SELECT
          p.location,
          p.event_date,
          guide.email AS guide_email,
          guide.member_id AS guide_member_id,
          guide.mobile_phone AS guide_mobile_phone,
          guide.sms_opt_in AS guide_sms_opt_in,
          vet.first_name AS vet_first_name
       FROM tavf_application ta
       INNER JOIN tavf_posting p ON p.posting_id = ta.posting_id
       INNER JOIN member guide ON guide.member_id = p.guide_member_id
       INNER JOIN member vet ON vet.member_id = ta.vet_member_id
       WHERE ta.application_id = @application_id`
    );
  const row = result.recordset[0];
  if (!row) {
    return;
  }

  const dateLabel = row.event_date.toLocaleDateString();
  const variables = {
    applicantName: row.vet_first_name ?? 'A member',
    location: row.location,
    eventDate: dateLabel,
  };
  const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
    subject: 'New TAVF Application - {{location}} on {{eventDate}}',
    htmlBody: '<p>{{applicantName}} applied for your TAVF posting at {{location}} on {{eventDate}}.</p>',
    textBody: '{{applicantName}} applied for your TAVF posting at {{location}} on {{eventDate}}.',
  }, variables);
  const renderedSms = renderSmsTemplate(
    smsTemplateOverride,
    'PHW Alpine TAVF: New application for your {{location}} posting on {{eventDate}}. Open app to review. Reply STOP to opt out.',
    variables
  );

  await notificationService.sendEmail({
    to: row.guide_email,
    subject: renderedEmail.subject,
    htmlBody: renderedEmail.htmlBody,
    textBody: renderedEmail.textBody,
    memberId: row.guide_member_id,
    operationType: 'tavf_application_received',
  });

  if (row.guide_sms_opt_in && row.guide_mobile_phone) {
    await notificationService.sendSms({
      to: row.guide_mobile_phone,
      message: renderedSms,
      memberId: row.guide_member_id,
      operationType: 'tavf_application_received',
    });
  }
}

async function notifyMatchConfirmed(matchId: string): Promise<void> {
  const pool = await getPool();
  const [emailTemplateOverride, smsTemplateOverride] = await Promise.all([
    getActiveTemplateOverride(tavfMatchConfirmedTemplateName, 'email'),
    getActiveTemplateOverride(tavfMatchConfirmedTemplateName, 'sms'),
  ]);

  const result = await pool
    .request()
    .input('match_id', sql.UniqueIdentifier, matchId)
    .query<{
      posting_id: string;
      location: string;
      event_date: Date;
      guide_email: string;
      guide_member_id: string;
      guide_mobile_phone: string | null;
      guide_sms_opt_in: boolean;
      vet_email: string;
      vet_member_id: string;
      vet_mobile_phone: string | null;
      vet_sms_opt_in: boolean;
    }>(
      `SELECT
          p.posting_id,
          p.location,
          p.event_date,
          guide.email AS guide_email,
          guide.member_id AS guide_member_id,
          guide.mobile_phone AS guide_mobile_phone,
          guide.sms_opt_in AS guide_sms_opt_in,
          vet.email AS vet_email,
          vet.member_id AS vet_member_id,
          vet.mobile_phone AS vet_mobile_phone,
          vet.sms_opt_in AS vet_sms_opt_in
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
  const variables = {
    location: row.location,
    eventDate: dateLabel,
  };
  const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
    subject: 'TAVF Match Confirmed - {{location}} on {{eventDate}}',
    htmlBody: '<p>Your TAVF match is confirmed for {{location}} on {{eventDate}}.</p>',
    textBody: 'Your TAVF match is confirmed for {{location}} on {{eventDate}}.',
  }, variables);
  const renderedSms = renderSmsTemplate(
    smsTemplateOverride,
    'PHW Alpine TAVF: Match confirmed for {{location}} on {{eventDate}}.',
    variables
  );

  await notificationService.sendEmail({
    to: row.guide_email,
    subject: renderedEmail.subject,
    htmlBody: renderedEmail.htmlBody,
    textBody: renderedEmail.textBody,
    memberId: row.guide_member_id,
    operationType: 'tavf_match_confirmed',
  });

  await notificationService.sendEmail({
    to: row.vet_email,
    subject: renderedEmail.subject,
    htmlBody: renderedEmail.htmlBody,
    textBody: renderedEmail.textBody,
    memberId: row.vet_member_id,
    operationType: 'tavf_match_confirmed',
  });

  if (row.guide_sms_opt_in && row.guide_mobile_phone) {
    await notificationService.sendSms({
      to: row.guide_mobile_phone,
      message: renderedSms,
      memberId: row.guide_member_id,
      operationType: 'tavf_match_confirmed',
    });
  }

  if (row.vet_sms_opt_in && row.vet_mobile_phone) {
    await notificationService.sendSms({
      to: row.vet_mobile_phone,
      message: renderedSms,
      memberId: row.vet_member_id,
      operationType: 'tavf_match_confirmed',
    });
  }
}

async function notifyMatchCancelled(matchId: string): Promise<void> {
  const pool = await getPool();
  const [emailTemplateOverride, smsTemplateOverride] = await Promise.all([
    getActiveTemplateOverride(tavfMatchCancelledTemplateName, 'email'),
    getActiveTemplateOverride(tavfMatchCancelledTemplateName, 'sms'),
  ]);

  const result = await pool
    .request()
    .input('match_id', sql.UniqueIdentifier, matchId)
    .query<{
      location: string;
      event_date: Date;
      guide_email: string;
      guide_member_id: string;
      guide_mobile_phone: string | null;
      guide_sms_opt_in: boolean;
      vet_email: string;
      vet_member_id: string;
      vet_mobile_phone: string | null;
      vet_sms_opt_in: boolean;
    }>(
      `SELECT
          p.location,
          p.event_date,
          guide.email AS guide_email,
          guide.member_id AS guide_member_id,
          guide.mobile_phone AS guide_mobile_phone,
          guide.sms_opt_in AS guide_sms_opt_in,
          vet.email AS vet_email,
          vet.member_id AS vet_member_id,
          vet.mobile_phone AS vet_mobile_phone,
          vet.sms_opt_in AS vet_sms_opt_in
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
  const variables = {
    location: row.location,
    eventDate: dateLabel,
  };
  const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
    subject: 'TAVF Match Cancelled - {{location}} on {{eventDate}}',
    htmlBody: '<p>Your TAVF match for {{location}} on {{eventDate}} has been cancelled.</p>',
    textBody: 'Your TAVF match for {{location}} on {{eventDate}} has been cancelled.',
  }, variables);
  const renderedSms = renderSmsTemplate(
    smsTemplateOverride,
    'PHW Alpine TAVF: Match cancelled for {{location}} on {{eventDate}}.',
    variables
  );

  await notificationService.sendEmail({
    to: row.guide_email,
    subject: renderedEmail.subject,
    htmlBody: renderedEmail.htmlBody,
    textBody: renderedEmail.textBody,
    memberId: row.guide_member_id,
    operationType: 'tavf_match_cancelled',
  });

  await notificationService.sendEmail({
    to: row.vet_email,
    subject: renderedEmail.subject,
    htmlBody: renderedEmail.htmlBody,
    textBody: renderedEmail.textBody,
    memberId: row.vet_member_id,
    operationType: 'tavf_match_cancelled',
  });

  if (row.guide_sms_opt_in && row.guide_mobile_phone) {
    await notificationService.sendSms({
      to: row.guide_mobile_phone,
      message: renderedSms,
      memberId: row.guide_member_id,
      operationType: 'tavf_match_cancelled',
    });
  }

  if (row.vet_sms_opt_in && row.vet_mobile_phone) {
    await notificationService.sendSms({
      to: row.vet_mobile_phone,
      message: renderedSms,
      memberId: row.vet_member_id,
      operationType: 'tavf_match_cancelled',
    });
  }
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
  TwilioSmsService,
  sendEventCancelledNotification,
  sendEventCompletedNotification,
  sendEventPublishedNotification,
  sendEventUpdatedNotification,
  sendRsvpConfirmation,
  sendWaitlistPromotionNotification,
  StubEmailService,
  StubSmsService,
  notificationService,
  getAcsEmailProviderDeliveryStatus,
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
  ProviderDeliveryStatusResult,
};