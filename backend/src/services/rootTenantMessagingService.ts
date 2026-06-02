import { getPool, sql } from '../db';

type SmsProvider = 'acs' | 'twilio' | 'telnyx' | null;

interface TenantMessagingRow {
  tenant_id: string;
  email_from: string | null;
  email_reply_to: string | null;
  email_bcc_monitor: string | null;
  sms_provider: SmsProvider;
  sms_from: string | null;
  twilio_messaging_service_sid: string | null;
  telnyx_messaging_profile_id: string | null;
  telnyx_from_number: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface TenantMessaging {
  tenant_id: string;
  email_from: string | null;
  email_reply_to: string | null;
  email_bcc_monitor: string | null;
  sms_provider: SmsProvider;
  sms_from: string | null;
  twilio_messaging_service_sid: string | null;
  telnyx_messaging_profile_id: string | null;
  telnyx_from_number: string | null;
  created_at: string;
  updated_at: string;
}

interface UpsertTenantMessagingInput {
  tenantId: string;
  email_from?: string | null;
  email_reply_to?: string | null;
  email_bcc_monitor?: string | null;
  sms_provider?: SmsProvider;
  sms_from?: string | null;
  twilio_messaging_service_sid?: string | null;
  telnyx_messaging_profile_id?: string | null;
  telnyx_from_number?: string | null;
}

function toIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function normalizeOptional(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : null;
}

function validateEmail(value: string | null, fieldName: string): void {
  if (!value) {
    return;
  }
  const normalized = value.toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new Error(`${fieldName} must be a valid email address`);
  }
}

function validatePhone(value: string | null, fieldName: string): void {
  if (!value) {
    return;
  }
  if (!/^\+?[0-9]{7,20}$/.test(value)) {
    throw new Error(`${fieldName} must be a valid phone number`);
  }
}

function toTenantMessaging(row: TenantMessagingRow): TenantMessaging {
  return {
    tenant_id: row.tenant_id,
    email_from: row.email_from,
    email_reply_to: row.email_reply_to,
    email_bcc_monitor: row.email_bcc_monitor,
    sms_provider: row.sms_provider,
    sms_from: row.sms_from,
    twilio_messaging_service_sid: row.twilio_messaging_service_sid,
    telnyx_messaging_profile_id: row.telnyx_messaging_profile_id,
    telnyx_from_number: row.telnyx_from_number,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

async function getTenantMessaging(tenantId: string): Promise<TenantMessaging | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .query<TenantMessagingRow>(
      `SELECT TOP (1)
          tenant_id,
          email_from,
          email_reply_to,
          email_bcc_monitor,
          sms_provider,
          sms_from,
          twilio_messaging_service_sid,
          telnyx_messaging_profile_id,
          telnyx_from_number,
          created_at,
          updated_at
       FROM dbo.tenant_messaging
       WHERE tenant_id = @tenant_id`
    );

  const row = result.recordset[0];
  return row ? toTenantMessaging(row) : null;
}

async function upsertTenantMessaging(input: UpsertTenantMessagingInput): Promise<TenantMessaging> {
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    throw new Error('tenantId is required');
  }

  const emailFrom = normalizeOptional(input.email_from);
  const emailReplyTo = normalizeOptional(input.email_reply_to);
  const emailBccMonitor = normalizeOptional(input.email_bcc_monitor);
  const smsProvider = input.sms_provider ?? null;
  const smsFrom = normalizeOptional(input.sms_from);
  const twilioMessagingServiceSid = normalizeOptional(input.twilio_messaging_service_sid);
  const telnyxMessagingProfileId = normalizeOptional(input.telnyx_messaging_profile_id);
  const telnyxFromNumber = normalizeOptional(input.telnyx_from_number);

  if (smsProvider && !['acs', 'twilio', 'telnyx'].includes(smsProvider)) {
    throw new Error('sms_provider must be one of: acs, twilio, telnyx');
  }

  validateEmail(emailFrom, 'email_from');
  validateEmail(emailReplyTo, 'email_reply_to');
  validateEmail(emailBccMonitor, 'email_bcc_monitor');
  validatePhone(smsFrom, 'sms_from');
  validatePhone(telnyxFromNumber, 'telnyx_from_number');

  const pool = await getPool();
  const result = await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('email_from', sql.NVarChar(255), emailFrom)
    .input('email_reply_to', sql.NVarChar(255), emailReplyTo)
    .input('email_bcc_monitor', sql.NVarChar(255), emailBccMonitor)
    .input('sms_provider', sql.NVarChar(20), smsProvider)
    .input('sms_from', sql.NVarChar(30), smsFrom)
    .input('twilio_messaging_service_sid', sql.NVarChar(64), twilioMessagingServiceSid)
    .input('telnyx_messaging_profile_id', sql.NVarChar(64), telnyxMessagingProfileId)
    .input('telnyx_from_number', sql.NVarChar(30), telnyxFromNumber)
    .query<TenantMessagingRow>(
      `IF NOT EXISTS (SELECT 1 FROM dbo.tenant WHERE tenant_id = @tenant_id)
         THROW 50001, 'Tenant not found', 1;

       IF EXISTS (SELECT 1 FROM dbo.tenant_messaging WHERE tenant_id = @tenant_id)
         BEGIN
           UPDATE dbo.tenant_messaging
           SET email_from = @email_from,
               email_reply_to = @email_reply_to,
               email_bcc_monitor = @email_bcc_monitor,
               sms_provider = @sms_provider,
               sms_from = @sms_from,
               twilio_messaging_service_sid = @twilio_messaging_service_sid,
               telnyx_messaging_profile_id = @telnyx_messaging_profile_id,
               telnyx_from_number = @telnyx_from_number,
               updated_at = GETUTCDATE()
           WHERE tenant_id = @tenant_id;
         END
       ELSE
         BEGIN
           INSERT INTO dbo.tenant_messaging (
             tenant_id,
             email_from,
             email_reply_to,
             email_bcc_monitor,
             sms_provider,
             sms_from,
             twilio_messaging_service_sid,
             telnyx_messaging_profile_id,
             telnyx_from_number,
             created_at,
             updated_at
           )
           VALUES (
             @tenant_id,
             @email_from,
             @email_reply_to,
             @email_bcc_monitor,
             @sms_provider,
             @sms_from,
             @twilio_messaging_service_sid,
             @telnyx_messaging_profile_id,
             @telnyx_from_number,
             GETUTCDATE(),
             GETUTCDATE()
           );
         END

       SELECT TOP (1)
         tenant_id,
         email_from,
         email_reply_to,
         email_bcc_monitor,
         sms_provider,
         sms_from,
         twilio_messaging_service_sid,
         telnyx_messaging_profile_id,
         telnyx_from_number,
         created_at,
         updated_at
       FROM dbo.tenant_messaging
       WHERE tenant_id = @tenant_id`
    );

  const row = result.recordset[0];
  if (!row) {
    throw new Error('Failed to upsert tenant messaging');
  }

  return toTenantMessaging(row);
}

export { getTenantMessaging, upsertTenantMessaging };
export type { TenantMessaging, UpsertTenantMessagingInput, SmsProvider };
