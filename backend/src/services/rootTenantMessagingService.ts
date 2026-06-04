import { getPool, sql } from '../db';

type SmsProvider = 'acs' | 'twilio' | 'telnyx' | null;

interface TenantMessagingRow {
  tenant_id: string;
  email_enabled: boolean | number;
  sms_enabled: boolean | number;
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
  email_enabled: boolean;
  sms_enabled: boolean;
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
  email_enabled?: boolean | null;
  sms_enabled?: boolean | null;
  email_from?: string | null;
  email_reply_to?: string | null;
  email_bcc_monitor?: string | null;
  sms_provider?: SmsProvider;
  sms_from?: string | null;
  twilio_messaging_service_sid?: string | null;
  telnyx_messaging_profile_id?: string | null;
  telnyx_from_number?: string | null;
}

const DEFAULT_TENANT_ID = (process.env['DEFAULT_TENANT_ID'] ?? '1b6b9719-663a-4e56-8f7d-9a4bd4c10001').trim().toLowerCase();

interface GlobalSmsConfig {
  sms_provider: SmsProvider;
  sms_from: string | null;
  twilio_messaging_service_sid: string | null;
  telnyx_messaging_profile_id: string | null;
  telnyx_from_number: string | null;
}

function toIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function asBool(value: unknown, fallback = false): boolean {
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
    email_enabled: asBool(row.email_enabled, true),
    sms_enabled: asBool(row.sms_enabled, true),
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

function resolveGlobalSmsConfig(): GlobalSmsConfig {
  const explicitProviderRaw = normalizeOptional(process.env['GLOBAL_SMS_PROVIDER'] ?? process.env['SMS_PROVIDER']);
  const explicitProvider = explicitProviderRaw ? explicitProviderRaw.toLowerCase() as SmsProvider : null;

  const twilioMessagingServiceSid = normalizeOptional(process.env['TWILIO_MESSAGING_SERVICE_SID']);
  const telnyxMessagingProfileId = normalizeOptional(process.env['TELNYX_MESSAGING_PROFILE_ID']);
  const telnyxFromNumber = normalizeOptional(process.env['TELNYX_FROM_NUMBER']);
  const acsFromNumber = normalizeOptional(process.env['ACS_FROM_NUMBER'] ?? process.env['SMS_FROM_NUMBER']);
  const acsConnectionString = normalizeOptional(process.env['ACS_CONNECTION_STRING']);

  let smsProvider: SmsProvider = null;
  if (explicitProvider && ['acs', 'twilio', 'telnyx'].includes(explicitProvider)) {
    smsProvider = explicitProvider;
  } else if (twilioMessagingServiceSid) {
    smsProvider = 'twilio';
  } else if (telnyxMessagingProfileId || telnyxFromNumber) {
    smsProvider = 'telnyx';
  } else if (acsConnectionString || acsFromNumber) {
    smsProvider = 'acs';
  }

  return {
    sms_provider: smsProvider,
    sms_from: smsProvider === 'telnyx' ? telnyxFromNumber : (smsProvider === 'acs' ? acsFromNumber : null),
    twilio_messaging_service_sid: smsProvider === 'twilio' ? twilioMessagingServiceSid : null,
    telnyx_messaging_profile_id: smsProvider === 'telnyx' ? telnyxMessagingProfileId : null,
    telnyx_from_number: smsProvider === 'telnyx' ? telnyxFromNumber : null,
  };
}

function mergeEmailDefaults(primary: TenantMessagingRow, fallback: TenantMessagingRow | null): TenantMessagingRow {
  if (!fallback || primary.tenant_id.toLowerCase() === fallback.tenant_id.toLowerCase()) {
    return primary;
  }

  return {
    ...primary,
    email_from: primary.email_from ?? fallback.email_from,
    email_reply_to: primary.email_reply_to ?? fallback.email_reply_to,
    email_bcc_monitor: primary.email_bcc_monitor ?? fallback.email_bcc_monitor,
  };
}

function applyGlobalSmsOverrides(base: TenantMessagingRow, overrides: GlobalSmsConfig): TenantMessagingRow {
  return {
    ...base,
    sms_provider: overrides.sms_provider,
    sms_from: overrides.sms_from,
    twilio_messaging_service_sid: overrides.twilio_messaging_service_sid,
    telnyx_messaging_profile_id: overrides.telnyx_messaging_profile_id,
    telnyx_from_number: overrides.telnyx_from_number,
  };
}

async function getTenantMessaging(tenantId: string): Promise<TenantMessaging | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('default_tenant_id', sql.UniqueIdentifier, DEFAULT_TENANT_ID)
    .query<TenantMessagingRow>(
      `SELECT
          tenant_id,
          email_enabled,
          sms_enabled,
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
       WHERE tenant_id IN (@tenant_id, @default_tenant_id)`
    );

  const tenantRow = result.recordset.find((row) => row.tenant_id.toLowerCase() === tenantId.toLowerCase()) ?? null;
  if (!tenantRow) {
    return null;
  }

  const fallbackRow = result.recordset.find((row) => row.tenant_id.toLowerCase() === DEFAULT_TENANT_ID) ?? null;
  const merged = mergeEmailDefaults(tenantRow, fallbackRow);
  const withGlobalSms = applyGlobalSmsOverrides(merged, resolveGlobalSmsConfig());
  return toTenantMessaging(withGlobalSms);
}

async function upsertTenantMessaging(input: UpsertTenantMessagingInput): Promise<TenantMessaging> {
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    throw new Error('tenantId is required');
  }

  const emailFrom = normalizeOptional(input.email_from);
  const emailReplyTo = normalizeOptional(input.email_reply_to);
  const emailBccMonitor = normalizeOptional(input.email_bcc_monitor);
  const emailEnabled = input.email_enabled == null ? true : Boolean(input.email_enabled);
  const smsEnabled = input.sms_enabled == null ? true : Boolean(input.sms_enabled);
  const globalSms = resolveGlobalSmsConfig();
  const smsProvider = globalSms.sms_provider;
  const smsFrom = globalSms.sms_from;
  const twilioMessagingServiceSid = globalSms.twilio_messaging_service_sid;
  const telnyxMessagingProfileId = globalSms.telnyx_messaging_profile_id;
  const telnyxFromNumber = globalSms.telnyx_from_number;

  validateEmail(emailFrom, 'email_from');
  validateEmail(emailReplyTo, 'email_reply_to');
  validateEmail(emailBccMonitor, 'email_bcc_monitor');
  validatePhone(smsFrom, 'sms_from');
  validatePhone(telnyxFromNumber, 'telnyx_from_number');

  const pool = await getPool();
  const result = await pool
    .request()
    .input('tenant_id', sql.UniqueIdentifier, tenantId)
    .input('email_enabled', sql.Bit, emailEnabled ? 1 : 0)
    .input('sms_enabled', sql.Bit, smsEnabled ? 1 : 0)
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
             SET email_enabled = @email_enabled,
               sms_enabled = @sms_enabled,
               email_from = @email_from,
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
             email_enabled,
             sms_enabled,
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
             @email_enabled,
             @sms_enabled,
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
         email_enabled,
         sms_enabled,
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
