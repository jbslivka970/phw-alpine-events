import { EmailClient } from '@azure/communication-email';
import { SmsClient } from '@azure/communication-sms';
import { getPool, sql } from '../db';
import twilio from 'twilio';
import { loadAcsConfig, loadRsvpLinkConfig, loadTelnyxSmsConfig, loadTwilioSmsConfig } from '../config';
import { renderTemplate } from '../templates/NotificationTemplate';
import { eventCancellationTemplate } from '../templates/eventCancellation';
import { eventInviteTemplate } from '../templates/eventInvite';
import { eventThankYouTemplate } from '../templates/eventThankYou';
import { eventUpdateTemplate } from '../templates/eventUpdate';
import { rsvpConfirmationTemplate } from '../templates/rsvpConfirmation';
import { rsvpWaitlistedTemplate } from '../templates/rsvpWaitlisted';
import { assignmentConfirmationTemplate } from '../templates/assignmentConfirmation';
import { assignmentAdminAddedTemplate } from '../templates/assignmentAdminAdded';
import { waitlistPromotionTemplate } from '../templates/waitlistPromotion';
import { buildMemberEmailUnsubscribeUrl } from './emailPreferenceLinkService';
import { buildMemberRsvpUrls, createShortRsvpUrlFromLandingUrl, type ResponseRole } from './rsvpLinkService';
import { formatInProgramTimeZone } from '../utils/dateTime';
import { stripHtmlToText } from '../utils/htmlText';

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

let cachedTenantMessagingHasChannelToggles: boolean | null = null;

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
  tenantId?: string;
}

interface EventUpdateNotificationPayload extends EventNotificationPayload {
  changedFields: string[];
  changeSummary?: string | null;
  updateReason?: string | null;
}

let cachedEmailPreferenceLogHasTenantId: boolean | null = null;

async function emailPreferenceLogHasTenantIdColumn(pool: Awaited<ReturnType<typeof getPool>>): Promise<boolean> {
  if (cachedEmailPreferenceLogHasTenantId !== null) {
    return cachedEmailPreferenceLogHasTenantId;
  }

  const result = await pool
    .request()
    .query<{ has_tenant_id: number }>(
      `SELECT CASE WHEN COL_LENGTH('dbo.email_preference_log', 'tenant_id') IS NULL THEN 0 ELSE 1 END AS has_tenant_id`
    );

  cachedEmailPreferenceLogHasTenantId = result.recordset[0]?.has_tenant_id === 1;
  return cachedEmailPreferenceLogHasTenantId;
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
  replyTo?: string;
  subject: string;
  htmlBody: string;
  textBody?: string;
  templateId?: string;
  memberId?: string;
  tenantId?: string;
  eventId?: string;
  operationType?: string;
  operationReason?: string;
}

interface SendSmsOptions {
  to: string;
  message: string;
  tenantId?: string;
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
    const normalizedReplyTo = normalizeSingleEmail(options.replyTo);

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
      ...(normalizedReplyTo ? { replyTo: [{ address: normalizedReplyTo }] } : {}),
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

function normalizeSingleEmail(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : undefined;
}

function resolveReplyToAddress(): string | undefined {
  const explicitReplyTo = normalizeSingleEmail(process.env['ACS_EMAIL_REPLY_TO']);
  if (explicitReplyTo) {
    return explicitReplyTo;
  }

  const inboundSupport = normalizeSingleEmail(process.env['SUPPORT_INBOUND_EMAIL']);
  if (inboundSupport) {
    return inboundSupport;
  }

  return normalizeSingleEmail(process.env['AUTH_DIAGNOSTICS_EMAIL']);
}

const DEFAULT_TEST_SMS_ALLOWLIST = '9704180120';
const TEST_TRAFFIC_MARKER_REGEX = /(playwright|smoke river|authz smoke|contract probe|\be2e\b)/i;

function normalizePhoneForGuard(value: string): string {
  const digits = value.replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  return digits;
}

function parseSmsAllowlist(raw: string | undefined): Set<string> {
  const source = (raw ?? DEFAULT_TEST_SMS_ALLOWLIST).trim();
  if (!source) {
    return new Set();
  }

  const values = source
    .split(/[\s,;|]+/)
    .map((value) => normalizePhoneForGuard(value))
    .filter((value) => value.length >= 10);
  return new Set(values);
}

const testSmsAllowlist = parseSmsAllowlist(
  process.env['TEST_NOTIFICATION_SMS_ALLOWLIST']
  ?? process.env['E2E_TEST_SMS_ALLOWLIST']
  ?? process.env['SMS_TEST_ALLOWLIST']
);

function isAllowedTestSmsRecipient(phoneNumber: string): boolean {
  const normalized = normalizePhoneForGuard(phoneNumber);
  return normalized.length > 0 && testSmsAllowlist.has(normalized);
}

function appendOperationReason(base: string | undefined, suffix: string): string {
  const merged = base ? `${base}; ${suffix}` : suffix;
  return merged.length > 500 ? merged.slice(0, 500) : merged;
}

function isLikelyTestTraffic(operationType: string | undefined, fragments: Array<string | undefined>): boolean {
  const operation = (operationType ?? '').toLowerCase();
  if (!operation.includes('tavf') && !operation.includes('smoke') && !operation.includes('e2e') && !operation.includes('test')) {
    return false;
  }

  if (TEST_TRAFFIC_MARKER_REGEX.test(operation)) {
    return true;
  }

  const content = fragments
    .filter((fragment): fragment is string => typeof fragment === 'string' && fragment.trim().length > 0)
    .join(' ');
  return TEST_TRAFFIC_MARKER_REGEX.test(content);
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
  private readonly tenantChannelPolicyCache = new Map<string, { emailEnabled: boolean; smsEnabled: boolean; expiresAtMs: number }>();
  private readonly tenantChannelPolicyCacheTtlMs = 60_000;

  constructor(
    private readonly emailService: IEmailService,
    private readonly smsService: ISmsService,
    private readonly isRealEmailService: boolean,
    private readonly isRealSmsService: boolean
  ) {}

  async sendEmail(options: SendEmailOptions): Promise<void> {
    const emailPolicy = await this.getTenantChannelPolicyForRequest('email', options.tenantId, options.eventId);
    if (!emailPolicy.enabled) {
      await this.writeNotificationLog({
        channel: 'email',
        recipient: options.to,
        status: 'skipped',
        eventId: options.eventId,
        memberId: options.memberId,
        templateId: options.templateId,
        operationType: options.operationType,
        operationReason: appendOperationReason(options.operationReason, 'blocked:tenant_email_disabled'),
      });
      return;
    }

    if (isLikelyTestTraffic(options.operationType, [options.subject, options.textBody, options.htmlBody, options.operationReason])) {
      await this.writeNotificationLog({
        channel: 'email',
        recipient: options.to,
        status: 'skipped',
        eventId: options.eventId,
        memberId: options.memberId,
        templateId: options.templateId,
        operationType: options.operationType,
        operationReason: appendOperationReason(options.operationReason, 'blocked:test_traffic_email_guard'),
      });
      return;
    }

    let status: NotificationStatus = this.isRealEmailService ? 'sent' : 'stubbed';
    let errorMessage: string | undefined;
    let providerId: string | undefined;
    const preparedOptions = this.appendEmailPreferenceFooter({
      ...options,
      replyTo: options.replyTo ?? resolveReplyToAddress(),
    });

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
      unsubscribeUrl = buildMemberEmailUnsubscribeUrl(options.memberId, options.to, options.tenantId);
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
    const smsPolicy = await this.getTenantChannelPolicyForRequest('sms', options.tenantId, options.eventId);
    if (!smsPolicy.enabled) {
      await this.writeNotificationLog({
        channel: 'sms',
        recipient: options.to,
        status: 'skipped',
        eventId: options.eventId,
        memberId: options.memberId,
        templateId: options.templateId,
        operationType: options.operationType,
        operationReason: appendOperationReason(options.operationReason, 'blocked:tenant_sms_disabled'),
      });
      return;
    }

    const normalizedMessage = truncateSms(options.message);
    if (normalizedMessage !== options.message) {
      console.warn('[NotificationService] SMS exceeded max length and was compacted before send.');
    }

    if (isLikelyTestTraffic(options.operationType, [options.message, options.operationReason]) && !isAllowedTestSmsRecipient(options.to)) {
      await this.writeNotificationLog({
        channel: 'sms',
        recipient: options.to,
        status: 'skipped',
        eventId: options.eventId,
        memberId: options.memberId,
        templateId: options.templateId,
        operationType: options.operationType,
        operationReason: appendOperationReason(options.operationReason, 'blocked:test_traffic_sms_allowlist'),
      });
      return;
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

  private async getTenantChannelPolicyForRequest(
    channel: NotificationChannel,
    tenantId?: string,
    eventId?: string
  ): Promise<{ enabled: boolean; tenantId: string | null }> {
    const resolvedTenantId = await this.resolveTenantIdForNotification(tenantId, eventId);
    if (!resolvedTenantId) {
      return { enabled: true, tenantId: null };
    }

    const policy = await this.getTenantChannelPolicy(resolvedTenantId);
    return {
      enabled: channel === 'email' ? policy.emailEnabled : policy.smsEnabled,
      tenantId: resolvedTenantId,
    };
  }

  private async resolveTenantIdForNotification(tenantId?: string, eventId?: string): Promise<string | null> {
    const normalizedTenantId = toNullableUuid(tenantId);
    if (normalizedTenantId) {
      return normalizedTenantId;
    }

    const normalizedEventId = toNullableUuid(eventId);
    if (!normalizedEventId) {
      return null;
    }

    try {
      const pool = await getPool();
      const result = await pool
        .request()
        .input('event_id', sql.UniqueIdentifier, normalizedEventId)
        .query<{ tenant_id: string | null }>(
          `SELECT TOP (1) tenant_id
           FROM dbo.event
           WHERE event_id = @event_id`
        );

      return toNullableUuid(result.recordset[0]?.tenant_id ?? undefined);
    } catch {
      return null;
    }
  }

  private async getTenantChannelPolicy(tenantId: string): Promise<{ emailEnabled: boolean; smsEnabled: boolean }> {
    const now = Date.now();
    const cached = this.tenantChannelPolicyCache.get(tenantId);
    if (cached && cached.expiresAtMs > now) {
      return {
        emailEnabled: cached.emailEnabled,
        smsEnabled: cached.smsEnabled,
      };
    }

    try {
      const pool = await getPool();
      const hasToggles = await this.tenantMessagingHasChannelToggleColumns(pool);
      if (!hasToggles) {
        return { emailEnabled: true, smsEnabled: true };
      }

      const result = await pool
        .request()
        .input('tenant_id', sql.UniqueIdentifier, tenantId)
        .query<{ email_enabled: boolean | number | null; sms_enabled: boolean | number | null }>(
          `SELECT TOP (1) email_enabled, sms_enabled
           FROM dbo.tenant_messaging
           WHERE tenant_id = @tenant_id`
        );

      const row = result.recordset[0];
      const policy = {
        emailEnabled: row ? toBitBoolean(row.email_enabled, true) : true,
        smsEnabled: row ? toBitBoolean(row.sms_enabled, true) : true,
      };

      this.tenantChannelPolicyCache.set(tenantId, {
        ...policy,
        expiresAtMs: now + this.tenantChannelPolicyCacheTtlMs,
      });

      return policy;
    } catch {
      return { emailEnabled: true, smsEnabled: true };
    }
  }

  private async tenantMessagingHasChannelToggleColumns(pool: Awaited<ReturnType<typeof getPool>>): Promise<boolean> {
    if (cachedTenantMessagingHasChannelToggles !== null) {
      return cachedTenantMessagingHasChannelToggles;
    }

    const result = await pool
      .request()
      .query<{ has_toggle_columns: number }>(
        `SELECT CASE
            WHEN COL_LENGTH('dbo.tenant_messaging', 'email_enabled') IS NULL THEN 0
            WHEN COL_LENGTH('dbo.tenant_messaging', 'sms_enabled') IS NULL THEN 0
            ELSE 1
          END AS has_toggle_columns`
      );

    cachedTenantMessagingHasChannelToggles = result.recordset[0]?.has_toggle_columns === 1;
    return cachedTenantMessagingHasChannelToggles;
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
    tenantId?: string;
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
      const hasTenantIdColumn = await emailPreferenceLogHasTenantIdColumn(pool);
      const request = pool
        .request()
        .input('member_id', sql.UniqueIdentifier, toNullableUuid(entry.memberId))
        .input('recipient_email', sql.NVarChar(255), entry.recipientEmail ?? null)
        .input('action', sql.NVarChar(20), entry.action)
        .input('source', sql.NVarChar(20), entry.source)
        .input('outcome', sql.NVarChar(30), entry.outcome)
        .input('token_expires_at', sql.DateTime, tokenExpiresAt)
        .input('notes', sql.NVarChar(500), entry.notes ?? null);

      if (hasTenantIdColumn) {
        request.input('tenant_id', sql.UniqueIdentifier, toNullableUuid(entry.tenantId));
      }

      await request.query(
        hasTenantIdColumn
          ? `INSERT INTO email_preference_log (
                email_preference_log_id,
                tenant_id,
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
                @tenant_id,
                @member_id,
                @recipient_email,
                @action,
                @source,
                @outcome,
                @token_expires_at,
                @notes,
                GETUTCDATE()
             )`
          : `INSERT INTO email_preference_log (
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

function toBitBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function normalizeTemplateBody(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isLegacyEventInviteSmsBody(body: string): boolean {
  const normalized = normalizeTemplateBody(body);
  const legacy = normalizeTemplateBody('PHW Alpine invite: {{eventTitle}}\n{{eventDate}} at {{location}}\nRSVP: {{rsvpUrl}}\nReply STOP to opt out');
  return normalized === legacy;
}

function getFrontendAppBaseUrl(): string {
  const configured = loadRsvpLinkConfig().frontendBaseUrl?.trim();
  return configured || 'https://app.phwcoloradoalpine.org';
}

function toAbsoluteAppUrl(pathOrUrl: string): string {
  const normalized = pathOrUrl.trim();
  if (!normalized) {
    return getFrontendAppBaseUrl();
  }

  try {
    return new URL(normalized).toString();
  } catch {
    const path = normalized.startsWith('/') ? normalized : `/${normalized}`;
    return `${getFrontendAppBaseUrl()}${path}`;
  }
}

function summarizePlainText(value: string | null | undefined, maxLength: number): string {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(maxLength - 3, 0)).trimEnd()}...`;
}

function formatSlotLabel(count: number): string {
  return count === 1 ? '1 participant slot' : `${count} participant slots`;
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
    if (!row) {
      return null;
    }

    // Keep existing custom templates, but skip the legacy generic Event Invite SMS override.
    // This allows the richer built-in Event Invite SMS template to flow without forcing a DB migration.
    if (templateName === eventInviteTemplate.displayName && channel === 'sms' && isLegacyEventInviteSmsBody(row.body)) {
      return null;
    }

    return { subject: row.subject, body: row.body };
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

async function withShortRsvpVariable(variables: Record<string, string>): Promise<Record<string, string>> {
  const landingUrl = variables.rsvpUrl;
  if (!landingUrl) {
    return variables;
  }

  const shortUrl = await createShortRsvpUrlFromLandingUrl(landingUrl);
  if (!shortUrl || shortUrl === landingUrl) {
    return variables;
  }

  return {
    ...variables,
    rsvpUrl: shortUrl,
  };
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
         AND er.response IN ('yes', 'no', 'maybe', 'waitlist')
       UNION
       SELECT DISTINCT
          m.email,
          m.mobile_phone,
          m.sms_opt_in,
          m.email_opt_out
       FROM event_assignment ea
       INNER JOIN member m ON m.member_id = ea.member_id
       WHERE ea.event_id = @event_id`
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
       INNER JOIN event e ON e.event_id = ent.event_id
       LEFT JOIN member_group mg ON mg.group_id = ent.group_id
       LEFT JOIN [group] g ON g.group_id = ent.group_id
       LEFT JOIN member m ON m.member_id = COALESCE(ent.member_id, mg.member_id)
       WHERE ent.event_id = @event_id
          ${targetGroupPredicate ? `AND ent.group_id IN (${targetGroupPredicate})` : ''}
         AND m.member_id IS NOT NULL
         AND (e.event_lead_member_id IS NULL OR m.member_id <> e.event_lead_member_id)`
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
      const smsVariables = await withShortRsvpVariable(variables);
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderSmsTemplate(smsTemplateOverride, eventInviteTemplate.smsBodyTemplate ?? '', smsVariables),
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
         AND er.response IN ('yes', 'no', 'maybe', 'waitlist')
       UNION
       SELECT DISTINCT
          m.member_id,
          m.first_name,
          m.email,
          m.mobile_phone,
          m.sms_opt_in,
          m.email_opt_out,
          NULL AS response_channel
       FROM event_assignment ea
       INNER JOIN member m ON m.member_id = ea.member_id
       WHERE ea.event_id = @event_id`
    );

  const variables = buildEventVariables(payload);

  for (const recipient of recipientsResult.recordset) {
    const preferredChannel = pickPreferredChannel(recipient.response_channel);
    const canEmail = Boolean(!recipient.email_opt_out && recipient.email);
    const canSms = Boolean(recipient.mobile_phone && recipient.sms_opt_in);

    if (preferredChannel === 'sms' && canSms) {
      const smsVariables = await withShortRsvpVariable(variables);
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderSmsTemplate(smsTemplateOverride, eventCancellationTemplate.smsBodyTemplate ?? '', smsVariables),
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
      const smsVariables = await withShortRsvpVariable(variables);
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderSmsTemplate(smsTemplateOverride, eventCancellationTemplate.smsBodyTemplate ?? '', smsVariables),
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
      const smsVariables = await withShortRsvpVariable(variables);
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderSmsTemplate(smsTemplateOverride, eventUpdateTemplate.smsBodyTemplate ?? '', smsVariables),
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
      const smsVariables = await withShortRsvpVariable(variables);
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderSmsTemplate(smsTemplateOverride, eventUpdateTemplate.smsBodyTemplate ?? '', smsVariables),
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

async function sendEventRsvpReminderToNonResponders(payload: EventNotificationPayload): Promise<void> {
  const [emailTemplateOverride, smsTemplateOverride] = await Promise.all([
    getActiveTemplateOverride(eventInviteTemplate.displayName, 'email'),
    getActiveTemplateOverride(eventInviteTemplate.displayName, 'sms'),
  ]);

  const pool = await getPool();
  const recipientsResult = await pool
    .request()
    .input('event_id', sql.UniqueIdentifier, payload.event_id)
    .query<{
      member_id: string;
      group_context_id: string | null;
      group_name: string | null;
      email: string;
      mobile_phone: string | null;
      sms_opt_in: boolean;
      email_opt_out: boolean;
    }>(
      `WITH eligible AS (
          SELECT
            m.member_id,
            ent.group_id AS group_context_id,
            g.group_name,
            m.email,
            m.mobile_phone,
            m.sms_opt_in,
            m.email_opt_out,
            ROW_NUMBER() OVER (
              PARTITION BY m.member_id
              ORDER BY CASE WHEN ent.group_id IS NULL THEN 1 ELSE 0 END, ent.group_id
            ) AS row_num
          FROM event_notification_target ent
          INNER JOIN event e ON e.event_id = ent.event_id
          LEFT JOIN member_group mg ON mg.group_id = ent.group_id
          LEFT JOIN [group] g ON g.group_id = ent.group_id
          LEFT JOIN member m ON m.member_id = COALESCE(ent.member_id, mg.member_id)
          LEFT JOIN event_response er ON er.event_id = ent.event_id AND er.member_id = m.member_id
          WHERE ent.event_id = @event_id
            AND m.member_id IS NOT NULL
            AND m.is_active = 1
            AND (e.event_lead_member_id IS NULL OR m.member_id <> e.event_lead_member_id)
            AND er.response_id IS NULL
            AND NOT EXISTS (
              SELECT 1
              FROM event_response er_email
              INNER JOIN member m_email ON m_email.member_id = er_email.member_id
              WHERE er_email.event_id = ent.event_id
                AND er_email.response = 'no'
                AND m.email IS NOT NULL
                AND LOWER(LTRIM(RTRIM(m_email.email))) = LOWER(LTRIM(RTRIM(m.email)))
            )
        )
        SELECT
          member_id,
          group_context_id,
          group_name,
          email,
          mobile_phone,
          sms_opt_in,
          email_opt_out
        FROM eligible
        WHERE row_num = 1`
    );

  let sentEmailCount = 0;
  let sentSmsCount = 0;
  let skippedCount = 0;

  for (const recipient of recipientsResult.recordset) {
    const inferredRole = inferRoleFromGroupName(recipient.group_name);
    if (payload.invitation_stage === 'volunteer' && inferredRole !== 'MENTOR') {
      skippedCount += 1;
      continue;
    }
    if (payload.invitation_stage === 'participant' && inferredRole !== 'PARTICIPANT') {
      skippedCount += 1;
      continue;
    }

    const canEmail = Boolean(!recipient.email_opt_out && recipient.email);
    const canSms = Boolean(recipient.mobile_phone && recipient.sms_opt_in);
    if (!canEmail && !canSms) {
      skippedCount += 1;
      continue;
    }

    const variables = {
      ...buildEventVariables(payload, recipient.member_id, recipient.group_context_id ?? undefined, inferredRole),
      reminderNote: 'Friendly reminder: please RSVP so we can plan guides, logistics, and attendance.',
    };

    if (canEmail) {
      const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
        subject: 'Reminder: RSVP requested for {{eventTitle}}',
        htmlBody: '<p>{{reminderNote}}</p><p><strong>{{eventTitle}}</strong><br/>{{eventDate}}<br/>{{location}}</p><p>RSVP: <a href="{{rsvpUrl}}">{{rsvpUrl}}</a></p>',
        textBody: '{{reminderNote}}\n\n{{eventTitle}}\n{{eventDate}}\n{{location}}\nRSVP: {{rsvpUrl}}',
      }, variables);
      await notificationService.sendEmail({
        to: recipient.email,
        subject: renderedEmail.subject,
        htmlBody: renderedEmail.htmlBody,
        textBody: renderedEmail.textBody,
        templateId: eventInviteTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_rsvp_reminder',
      });
      sentEmailCount += 1;
    }

    if (canSms) {
      const smsVariables = await withShortRsvpVariable(variables);
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderSmsTemplate(
          smsTemplateOverride,
          'PHW Alpine reminder: please RSVP for {{eventTitle}} ({{eventDate}}). RSVP: {{rsvpUrl}} Reply STOP to opt out.',
          smsVariables,
        ),
        templateId: eventInviteTemplate.templateId,
        memberId: recipient.member_id,
        eventId: payload.event_id,
        operationType: 'event_rsvp_reminder',
      });
      sentSmsCount += 1;
    }
  }

  await sendCoordinatorSummaryEmail({
    eventLeadEmail: payload.event_lead_email,
    eventId: payload.event_id,
    subject: `Coordinator summary: RSVP reminders sent for ${payload.title}`,
    lines: [
      `Event: ${payload.title}`,
      `Date/time: ${formatEventDate(payload.event_date)}`,
      `Reminder recipients emailed: ${sentEmailCount}`,
      `Reminder recipients texted: ${sentSmsCount}`,
      `Recipients skipped: ${skippedCount}`,
    ],
    operationType: 'event_rsvp_reminder',
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
      const smsVariables = await withShortRsvpVariable(variables);
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderSmsTemplate(smsTemplateOverride, eventThankYouTemplate.smsBodyTemplate ?? '', smsVariables),
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
      const smsVariables = await withShortRsvpVariable(variables);
      await notificationService.sendSms({
        to: recipient.mobile_phone as string,
        message: renderSmsTemplate(smsTemplateOverride, eventThankYouTemplate.smsBodyTemplate ?? '', smsVariables),
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
    const normalizedStatus = (payload.rsvpStatus ?? '').trim().toLowerCase();
    const isNoResponse = normalizedStatus === 'no';
    const variables = {
      firstName: payload.firstName ?? 'Member',
      eventName: payload.eventTitle,
      eventDate: payload.eventDate ?? 'TBD',
      rsvpStatus: payload.rsvpStatus ?? 'confirmed',
    };

    const defaultEmailTemplates = isNoResponse
      ? {
          subject: 'RSVP Received: {{eventName}} — {{eventDate}}',
          htmlBody: `
    <div style="font-family:Segoe UI,Arial,sans-serif;line-height:1.5;color:#1f2937;max-width:640px;margin:0 auto;">
      <p>Hi {{firstName}},</p>
      <p>Thanks for letting us know you cannot make <strong>{{eventName}}</strong> on <strong>{{eventDate}}</strong>.</p>
      <p>We are looking forward to seeing you on the next one when you can. Stay tuned for future events!</p>
      <p style="margin-top:20px;">PHW Colorado Alpine</p>
    </div>
  `,
          textBody:
            "Hi {{firstName}},\n\nThanks for letting us know you cannot make {{eventName}} on {{eventDate}}.\n\nWe are looking forward to seeing you on the next one when you can. Stay tuned for future events!\n\nPHW Colorado Alpine",
        }
      : {
          subject: rsvpConfirmationTemplate.subjectTemplate ?? '',
          htmlBody: rsvpConfirmationTemplate.htmlBodyTemplate ?? '',
          textBody: rsvpConfirmationTemplate.textBodyTemplate ?? '',
        };

    const defaultSmsTemplate = isNoResponse
      ? 'PHW Alpine: Thanks for letting us know you cannot make {{eventName}} on {{eventDate}}. We are looking forward to seeing you on the next one when you can. Stay tuned for future events!'
      : (rsvpConfirmationTemplate.smsBodyTemplate ?? '');

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
      const renderedEmail = renderEmailTemplate(emailTemplateOverride, defaultEmailTemplates, variables);
      await notificationService.sendEmail({
        to: payload.recipientEmail,
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
        message: renderSmsTemplate(smsTemplateOverride, defaultSmsTemplate, variables),
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

interface AssignmentNotificationPayload {
  eventId: string;
  eventTitle: string;
  eventDate: string;
  memberId: string;
  firstName: string;
  role: string;
  recipientEmail?: string;
  recipientPhone?: string;
  smsOptIn?: boolean;
  hadRsvp: boolean;
}

function sendAssignmentConfirmation(payload: AssignmentNotificationPayload): void {
  void (async () => {
    const template = payload.hadRsvp ? assignmentConfirmationTemplate : assignmentAdminAddedTemplate;
    const variables = {
      firstName: payload.firstName ?? 'Member',
      eventName: payload.eventTitle,
      eventDate: payload.eventDate ?? 'TBD',
      role: payload.role === 'MENTOR' ? 'Mentor' : 'Participant',
    };

    if (!payload.recipientEmail && !payload.recipientPhone) {
      console.log('[STUB] sendAssignmentConfirmation skipped (no recipient)', payload);
      return;
    }

    const useRuntimeOverrides = process.env.NODE_ENV !== 'test';
    const [emailTemplateOverride, smsTemplateOverride] = useRuntimeOverrides
      ? await Promise.all([
          getActiveTemplateOverride(template.displayName, 'email'),
          getActiveTemplateOverride(template.displayName, 'sms'),
        ])
      : [null, null];

    if (payload.recipientEmail) {
      const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
        subject: template.subjectTemplate ?? '',
        htmlBody: template.htmlBodyTemplate ?? '',
        textBody: template.textBodyTemplate ?? '',
      }, variables);
      await notificationService.sendEmail({
        to: payload.recipientEmail,
        subject: renderedEmail.subject,
        htmlBody: renderedEmail.htmlBody,
        textBody: renderedEmail.textBody,
        templateId: template.templateId,
        memberId: payload.memberId,
        eventId: payload.eventId,
        operationType: 'assignment_confirmation',
      });
    }

    if (payload.recipientPhone && payload.smsOptIn) {
      await notificationService.sendSms({
        to: payload.recipientPhone,
        message: renderSmsTemplate(smsTemplateOverride, template.smsBodyTemplate ?? '', variables),
        templateId: template.templateId,
        memberId: payload.memberId,
        eventId: payload.eventId,
        operationType: 'assignment_confirmation',
      });
    }
  })().catch((error) => {
    console.error('[NotificationService] Failed to send assignment confirmation', {
      memberId: payload.memberId,
      eventId: payload.eventId,
      error,
    });
  });
}

interface RsvpWaitlistedPayload {
  eventId: string;
  eventTitle: string;
  eventDate: string;
  memberId: string;
  firstName: string;
  recipientEmail?: string;
  recipientPhone?: string;
}

function sendRsvpWaitlisted(payload: RsvpWaitlistedPayload): void {
  void (async () => {
    const variables = {
      firstName: payload.firstName ?? 'Member',
      eventName: payload.eventTitle,
      eventDate: payload.eventDate ?? 'TBD',
    };

    if (!payload.recipientEmail && !payload.recipientPhone) {
      console.log('[STUB] sendRsvpWaitlisted skipped (no recipient)', payload);
      return;
    }

    const useRuntimeOverrides = process.env.NODE_ENV !== 'test';
    const [emailTemplateOverride, smsTemplateOverride] = useRuntimeOverrides
      ? await Promise.all([
          getActiveTemplateOverride(rsvpWaitlistedTemplate.displayName, 'email'),
          getActiveTemplateOverride(rsvpWaitlistedTemplate.displayName, 'sms'),
        ])
      : [null, null];

    if (payload.recipientEmail) {
      const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
        subject: rsvpWaitlistedTemplate.subjectTemplate ?? '',
        htmlBody: rsvpWaitlistedTemplate.htmlBodyTemplate ?? '',
        textBody: rsvpWaitlistedTemplate.textBodyTemplate ?? '',
      }, variables);
      await notificationService.sendEmail({
        to: payload.recipientEmail,
        subject: renderedEmail.subject,
        htmlBody: renderedEmail.htmlBody,
        textBody: renderedEmail.textBody,
        templateId: rsvpWaitlistedTemplate.templateId,
        memberId: payload.memberId,
        eventId: payload.eventId,
        operationType: 'rsvp_waitlisted',
      });
    }

    if (payload.recipientPhone) {
      await notificationService.sendSms({
        to: payload.recipientPhone,
        message: renderSmsTemplate(smsTemplateOverride, rsvpWaitlistedTemplate.smsBodyTemplate ?? '', variables),
        templateId: rsvpWaitlistedTemplate.templateId,
        memberId: payload.memberId,
        eventId: payload.eventId,
        operationType: 'rsvp_waitlisted',
      });
    }
  })().catch((error) => {
    console.error('[NotificationService] Failed to send RSVP waitlisted notification', {
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
  const descriptionSnippet = summarizePlainText(payload.description, 120);
  const smsDescriptionLine = descriptionSnippet ? `\n${descriptionSnippet}` : '';
  const defaultRsvpUrl = `/events/${payload.event_id}`;
  let rsvpUrl = defaultRsvpUrl;
  let yesUrl = defaultRsvpUrl;
  let noUrl = defaultRsvpUrl;
  let maybeUrl = defaultRsvpUrl;
  let waitlistUrl = defaultRsvpUrl;
  const replyAddress = resolveReplyToAddress() ?? (process.env['ACS_EMAIL_FROM'] || 'Scheduler@mail.phwcoloradoalpine.org');
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
    descriptionSnippet,
    smsDescriptionLine,
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
  operationType: 'event_published' | 'event_updated' | 'event_rsvp_reminder';
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

const MAX_SMS_LENGTH = 1000;

function truncateSms(message: string, limit = MAX_SMS_LENGTH): string {
  if (message.length <= limit) {
    return message;
  }

  // Preserve a full URL and trailing compliance copy when possible so RSVP links
  // remain valid and legal text is retained when a message must be shortened.
  const urlMatch = message.match(/https?:\/\/\S+/i);
  if (urlMatch && typeof urlMatch.index === 'number') {
    const fullUrl = urlMatch[0];
    const intro = message.slice(0, urlMatch.index).trimEnd();
    const trailing = message.slice(urlMatch.index + fullUrl.length).trim();
    const trailingBudget = trailing ? trailing.length + 1 : 0;

    if (fullUrl.length + trailingBudget + 1 < limit) {
      const introBudget = limit - fullUrl.length - trailingBudget - 1;
      let compactIntro = intro;
      if (compactIntro.length > introBudget) {
        if (introBudget <= 3) {
          compactIntro = ''.padEnd(Math.max(introBudget, 0), '.');
        } else {
          compactIntro = `${compactIntro.slice(0, introBudget - 3).trimEnd()}...`;
        }
      }
      return [compactIntro, fullUrl, trailing].filter(Boolean).join(' ').trim();
    }

    if (fullUrl.length + 1 < limit) {
      const introBudget = limit - fullUrl.length - 1;
      let compactIntro = intro;
      if (compactIntro.length > introBudget) {
        if (introBudget <= 3) {
          compactIntro = ''.padEnd(Math.max(introBudget, 0), '.');
        } else {
          compactIntro = `${compactIntro.slice(0, introBudget - 3).trimEnd()}...`;
        }
      }
      return `${compactIntro} ${fullUrl}`.trim();
    }
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
    .query<{ posting_id: string; tenant_id: string; location: string; event_date: Date; capacity: number; species: string | null; description: string | null }>(
      `SELECT posting_id, tenant_id, location, event_date, capacity, species, description
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
    recipients.input('tenant_id', sql.UniqueIdentifier, posting.tenant_id);
    const subscribedRecipients = await recipients.query<{ email: string; member_id: string; mobile_phone: string | null; sms_opt_in: boolean; email_opt_out: boolean }>(
      `SELECT DISTINCT m.email, m.member_id, m.mobile_phone, m.sms_opt_in, m.email_opt_out
       FROM member m
       INNER JOIN tavf_notification_subscription tns ON tns.member_id = m.member_id
       INNER JOIN tenant_membership tm ON tm.member_id = m.member_id
       WHERE m.is_active = 1
         AND tns.is_subscribed = 1
         AND tm.tenant_id = @tenant_id
         AND tm.status = 'active'
         AND tm.revoked_at IS NULL
         AND tm.starts_at <= GETUTCDATE()
         AND (tm.expires_at IS NULL OR tm.expires_at > GETUTCDATE())
         AND ((m.email_opt_out = 0 OR m.email_opt_out IS NULL) OR (m.sms_opt_in = 1 AND m.mobile_phone IS NOT NULL))`
    );
    recipientRows = subscribedRecipients.recordset;
  } catch (subscriptionError) {
    console.warn('[NotificationService] tavf_notification_subscription not available, using ALL-group fallback.', subscriptionError);
    const fallbackRecipients = await pool
      .request()
      .input('tenant_id', sql.UniqueIdentifier, posting.tenant_id)
      .query<{ email: string; member_id: string; mobile_phone: string | null; sms_opt_in: boolean; email_opt_out: boolean }>(
        `SELECT DISTINCT m.email, m.member_id, m.mobile_phone, m.sms_opt_in, m.email_opt_out
         FROM member m
         INNER JOIN member_group mg ON mg.member_id = m.member_id
         INNER JOIN [group] g ON g.group_id = mg.group_id
         INNER JOIN tenant_membership tm ON tm.member_id = m.member_id
         WHERE g.group_name = 'ALL'
           AND g.tenant_id = @tenant_id
           AND tm.tenant_id = @tenant_id
           AND tm.status = 'active'
           AND tm.revoked_at IS NULL
           AND tm.starts_at <= GETUTCDATE()
           AND (tm.expires_at IS NULL OR tm.expires_at > GETUTCDATE())
           AND m.is_active = 1
           AND ((m.email_opt_out = 0 OR m.email_opt_out IS NULL) OR (m.sms_opt_in = 1 AND m.mobile_phone IS NOT NULL))`
      );
    recipientRows = fallbackRecipients.recordset;
  }

  const eventDate = formatInProgramTimeZone(posting.event_date);
  const postingUrl = toAbsoluteAppUrl(`/tavf/${posting.posting_id}`);
  const capacityLabel = formatSlotLabel(posting.capacity);
  const speciesLabel = posting.species?.trim() || '';
  const descriptionSummary = summarizePlainText(posting.description, 220);
  const smsDescriptionSummary = summarizePlainText(posting.description, 110);
  const variables = {
    location: posting.location,
    eventDate,
    postingUrl,
    capacityLabel,
    speciesSection: speciesLabel
      ? `<p style="margin:0 0 10px;color:#355345;font-size:14px;"><strong style="color:#1f4a3a;">Target:</strong> ${speciesLabel}</p>`
      : '',
    descriptionSection: descriptionSummary
      ? `<div style="margin:14px 0 0;padding:14px 15px;border-left:4px solid #d59b3d;background:#fff8eb;border-radius:0 12px 12px 0;line-height:1.55;color:#30463b;">${descriptionSummary}</div>`
      : '',
    speciesText: speciesLabel ? `\nTarget species: ${speciesLabel}` : '',
    descriptionText: descriptionSummary ? `\n${descriptionSummary}` : '',
    smsDetails: [capacityLabel, speciesLabel ? `Target: ${speciesLabel}` : ''].filter(Boolean).join(' · '),
    smsDescriptionLine: smsDescriptionSummary ? `\n${smsDescriptionSummary}` : '',
  };
  const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
    subject: 'New TAVF opportunity: {{location}} on {{eventDate}}',
    htmlBody: `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f7f3;padding:22px 10px;font-family:'Segoe UI',Arial,sans-serif;color:#1f2937;">
        <tr>
          <td align="center">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;width:100%;background:#ffffff;border:1px solid #d4ddd5;border-radius:18px;overflow:hidden;box-shadow:0 10px 28px rgba(25,43,34,0.08);">
              <tr>
                <td style="padding:22px 22px 20px;background:linear-gradient(132deg,#234b6b,#18344c);color:#ffffff;">
                  <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.14em;text-transform:uppercase;opacity:0.88;">Take A Vet Fishing</p>
                  <h2 style="margin:0;font-size:32px;line-height:1.12;letter-spacing:-0.02em;">New opportunity posted</h2>
                  <p style="margin:10px 0 0;font-size:15px;opacity:0.94;line-height:1.45;">A guide just opened a new TAVF day. If it fits your schedule, jump in early and claim a spot.</p>
                </td>
              </tr>
              <tr>
                <td style="padding:18px 18px 20px;">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #d4ddd5;border-radius:14px;background:#f7fbf8;">
                    <tr><td style="padding:14px 15px 6px;"><strong style="color:#1f4a3a;">Where:</strong> {{location}}</td></tr>
                    <tr><td style="padding:6px 15px;"><strong style="color:#1f4a3a;">When:</strong> {{eventDate}}</td></tr>
                    <tr><td style="padding:6px 15px 14px;"><strong style="color:#1f4a3a;">Availability:</strong> {{capacityLabel}}</td></tr>
                  </table>
                  <div style="margin:14px 0 0;">{{speciesSection}}</div>
                  {{descriptionSection}}
                  <p style="margin:18px 0 12px;color:#40574d;font-size:14px;">Open the posting in PHW Alpine to review the details and submit your interest.</p>
                  <p style="margin:0 0 14px;">
                    <a href="{{postingUrl}}" style="display:inline-block;padding:12px 18px;border-radius:999px;background:#234b6b;color:#ffffff;text-decoration:none;font-weight:700;">View opportunity</a>
                  </p>
                  <p style="margin:0;font-size:13px;color:#60756b;">Direct link: <a href="{{postingUrl}}" style="color:#234b6b;text-decoration:underline;">{{postingUrl}}</a></p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `,
    textBody: 'New TAVF opportunity: {{location}}\nWhen: {{eventDate}}\nAvailability: {{capacityLabel}}{{speciesText}}{{descriptionText}}\n\nView opportunity: {{postingUrl}}',
  }, variables);
  const renderedSms = renderSmsTemplate(
    smsTemplateOverride,
    'PHW Alpine TAVF\n{{location}}\n{{eventDate}}\n{{smsDetails}}{{smsDescriptionLine}}\nView: {{postingUrl}}\nReply STOP to opt out.',
    variables
  );

  for (const recipient of recipientRows) {
    if (recipient.email && !recipient.email_opt_out) {
      await notificationService.sendEmail({
        to: recipient.email,
        subject: renderedEmail.subject,
        htmlBody: renderedEmail.htmlBody,
        textBody: renderedEmail.textBody,
        tenantId: posting.tenant_id,
        memberId: recipient.member_id,
        operationType: 'tavf_new_posting',
      });
    }

    if (recipient.sms_opt_in && recipient.mobile_phone) {
      await notificationService.sendSms({
        to: recipient.mobile_phone,
        message: renderedSms,
        tenantId: posting.tenant_id,
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
      tenant_id: string;
      location: string;
      event_date: Date;
      guide_first_name: string | null;
      guide_last_name: string | null;
      guide_email: string;
      guide_member_id: string;
      guide_mobile_phone: string | null;
      guide_sms_opt_in: boolean;
      vet_first_name: string | null;
      vet_email: string;
      vet_member_id: string;
      vet_mobile_phone: string | null;
      vet_sms_opt_in: boolean;
    }>(
      `SELECT
          p.tenant_id,
          p.location,
          p.event_date,
          guide.first_name AS guide_first_name,
          guide.last_name AS guide_last_name,
          guide.email AS guide_email,
          guide.member_id AS guide_member_id,
          guide.mobile_phone AS guide_mobile_phone,
          guide.sms_opt_in AS guide_sms_opt_in,
          vet.first_name AS vet_first_name,
          vet.email AS vet_email,
          vet.member_id AS vet_member_id,
          vet.mobile_phone AS vet_mobile_phone,
          vet.sms_opt_in AS vet_sms_opt_in
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
    applicantEmail: row.vet_email,
    applicantPhone: row.vet_mobile_phone ?? 'not provided',
    guideName: [row.guide_first_name, row.guide_last_name].filter(Boolean).join(' ').trim() || 'Guide',
    guideEmail: row.guide_email,
    guidePhone: row.guide_mobile_phone ?? 'not provided',
  };
  const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
    subject: 'New TAVF Application - {{location}} on {{eventDate}}',
    htmlBody: '<p>{{applicantName}} applied for your TAVF posting at {{location}} on {{eventDate}}.</p><p>Applicant contact: {{applicantEmail}} {{applicantPhone}}</p>',
    textBody: '{{applicantName}} applied for your TAVF posting at {{location}} on {{eventDate}}. Applicant contact: {{applicantEmail}} {{applicantPhone}}',
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
    tenantId: row.tenant_id,
    memberId: row.guide_member_id,
    operationType: 'tavf_application_received',
  });

  if (row.guide_sms_opt_in && row.guide_mobile_phone) {
    await notificationService.sendSms({
      to: row.guide_mobile_phone,
      message: renderedSms,
      tenantId: row.tenant_id,
      memberId: row.guide_member_id,
      operationType: 'tavf_application_received',
    });
  }

  const applicantRenderedEmail = renderEmailTemplate(emailTemplateOverride, {
    subject: 'TAVF Interest Submitted - {{location}} on {{eventDate}}',
    htmlBody: '<p>Thanks for applying for {{location}} on {{eventDate}}.</p><p>Your guide contact: {{guideName}} ({{guideEmail}}, {{guidePhone}}).</p>',
    textBody: 'Thanks for applying for {{location}} on {{eventDate}}. Your guide contact: {{guideName}} ({{guideEmail}}, {{guidePhone}}).',
  }, variables);

  await notificationService.sendEmail({
    to: row.vet_email,
    subject: applicantRenderedEmail.subject,
    htmlBody: applicantRenderedEmail.htmlBody,
    textBody: applicantRenderedEmail.textBody,
    tenantId: row.tenant_id,
    memberId: row.vet_member_id,
    operationType: 'tavf_application_received',
  });

  if (row.vet_sms_opt_in && row.vet_mobile_phone) {
    await notificationService.sendSms({
      to: row.vet_mobile_phone,
      message: renderSmsTemplate(
        smsTemplateOverride,
        'PHW Alpine TAVF: Interest submitted for {{location}} on {{eventDate}}. Guide contact: {{guideEmail}} {{guidePhone}}. Reply STOP to opt out.',
        variables,
      ),
      tenantId: row.tenant_id,
      memberId: row.vet_member_id,
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
      tenant_id: string;
      posting_id: string;
      location: string;
      event_date: Date;
      guide_first_name: string | null;
      guide_last_name: string | null;
      guide_email: string;
      guide_member_id: string;
      guide_mobile_phone: string | null;
      guide_sms_opt_in: boolean;
      vet_first_name: string | null;
      vet_last_name: string | null;
      vet_email: string;
      vet_member_id: string;
      vet_mobile_phone: string | null;
      vet_sms_opt_in: boolean;
    }>(
      `SELECT
          p.tenant_id,
          p.posting_id,
          p.location,
          p.event_date,
          guide.first_name AS guide_first_name,
          guide.last_name AS guide_last_name,
          guide.email AS guide_email,
          guide.member_id AS guide_member_id,
          guide.mobile_phone AS guide_mobile_phone,
          guide.sms_opt_in AS guide_sms_opt_in,
          vet.first_name AS vet_first_name,
          vet.last_name AS vet_last_name,
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
    guideName: [row.guide_first_name, row.guide_last_name].filter(Boolean).join(' ').trim() || 'Guide',
    guideEmail: row.guide_email,
    guidePhone: row.guide_mobile_phone ?? 'not provided',
    participantName: [row.vet_first_name, row.vet_last_name].filter(Boolean).join(' ').trim() || 'Participant',
    participantEmail: row.vet_email,
    participantPhone: row.vet_mobile_phone ?? 'not provided',
  };
  const renderedEmail = renderEmailTemplate(emailTemplateOverride, {
    subject: 'TAVF Match Confirmed - {{location}} on {{eventDate}}',
    htmlBody: '<p>Your TAVF match is confirmed for {{location}} on {{eventDate}}.</p><p>Guide: {{guideName}} ({{guideEmail}}, {{guidePhone}})</p><p>Participant: {{participantName}} ({{participantEmail}}, {{participantPhone}})</p>',
    textBody: 'Your TAVF match is confirmed for {{location}} on {{eventDate}}. Guide: {{guideName}} ({{guideEmail}}, {{guidePhone}}). Participant: {{participantName}} ({{participantEmail}}, {{participantPhone}}).',
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
    tenantId: row.tenant_id,
    memberId: row.guide_member_id,
    operationType: 'tavf_match_confirmed',
  });

  await notificationService.sendEmail({
    to: row.vet_email,
    subject: renderedEmail.subject,
    htmlBody: renderedEmail.htmlBody,
    textBody: renderedEmail.textBody,
    tenantId: row.tenant_id,
    memberId: row.vet_member_id,
    operationType: 'tavf_match_confirmed',
  });

  if (row.guide_sms_opt_in && row.guide_mobile_phone) {
    await notificationService.sendSms({
      to: row.guide_mobile_phone,
      message: renderedSms,
      tenantId: row.tenant_id,
      memberId: row.guide_member_id,
      operationType: 'tavf_match_confirmed',
    });
  }

  if (row.vet_sms_opt_in && row.vet_mobile_phone) {
    await notificationService.sendSms({
      to: row.vet_mobile_phone,
      message: renderedSms,
      tenantId: row.tenant_id,
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
      tenant_id: string;
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
          p.tenant_id,
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
    tenantId: row.tenant_id,
    memberId: row.guide_member_id,
    operationType: 'tavf_match_cancelled',
  });

  await notificationService.sendEmail({
    to: row.vet_email,
    subject: renderedEmail.subject,
    htmlBody: renderedEmail.htmlBody,
    textBody: renderedEmail.textBody,
    tenantId: row.tenant_id,
    memberId: row.vet_member_id,
    operationType: 'tavf_match_cancelled',
  });

  if (row.guide_sms_opt_in && row.guide_mobile_phone) {
    await notificationService.sendSms({
      to: row.guide_mobile_phone,
      message: renderedSms,
      tenantId: row.tenant_id,
      memberId: row.guide_member_id,
      operationType: 'tavf_match_cancelled',
    });
  }

  if (row.vet_sms_opt_in && row.vet_mobile_phone) {
    await notificationService.sendSms({
      to: row.vet_mobile_phone,
      message: renderedSms,
      tenantId: row.tenant_id,
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
  sendEventRsvpReminderToNonResponders,
  sendEventUpdatedNotification,
  sendRsvpConfirmation,
  sendRsvpWaitlisted,
  sendAssignmentConfirmation,
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