import { createHash, randomUUID } from 'node:crypto';
import { getPool, sql } from '../db';

type OutboxChannel = 'email' | 'sms';
type OutboxPayload = Record<string, unknown>;

interface EnqueueNotificationOptions {
  tenantId?: string;
  channel: OutboxChannel;
  payload: OutboxPayload;
  dedupeKey?: string;
  availableAt?: Date;
}

interface NotificationOutboxRow {
  outbox_id: string;
  tenant_id: string | null;
  channel: OutboxChannel;
  payload: string;
  attempt_count: number;
  lease_token: string;
}

interface NotificationOutboxDispatcher {
  deliverOutboxEmail(payload: OutboxPayload): Promise<string | undefined>;
  deliverOutboxSms(payload: OutboxPayload): Promise<string | undefined>;
}

interface RunNotificationOutboxOptions {
  batchSize?: number;
  leaseMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

interface NotificationOutboxRunResult {
  claimed: number;
  sent: number;
  retried: number;
  deadLettered: number;
}

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_MS = 2 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 30 * 1000;
const DEFAULT_RETRY_MAX_MS = 60 * 60 * 1000;

function createNotificationDedupeKey(...parts: Array<string | number | null | undefined>): string {
  const canonical = parts.map((part) => part == null ? '' : String(part).trim()).join('\u001f');
  return createHash('sha256').update(canonical).digest('hex');
}

async function enqueueNotification(options: EnqueueNotificationOptions): Promise<string> {
  const pool = await getPool();
  const outboxId = randomUUID();
  const payload = JSON.stringify(options.payload);
  const dedupeKey = options.dedupeKey?.trim() || null;
  const result = await pool
    .request()
    .input('outbox_id', sql.UniqueIdentifier, outboxId)
    .input('tenant_id', sql.UniqueIdentifier, options.tenantId ?? null)
    .input('channel', sql.NVarChar(10), options.channel)
    .input('payload', sql.NVarChar(sql.MAX), payload)
    .input('dedupe_key', sql.NVarChar(128), dedupeKey)
    .input('available_at', sql.DateTime2, options.availableAt ?? new Date())
    .query<{ outbox_id: string }>(
      `BEGIN TRY
         INSERT INTO dbo.notification_outbox
           (outbox_id, tenant_id, channel, payload, dedupe_key, state, attempt_count, available_at, created_at, updated_at)
         OUTPUT INSERTED.outbox_id
         VALUES
           (@outbox_id, @tenant_id, @channel, @payload, @dedupe_key, 'queued', 0, @available_at, SYSUTCDATETIME(), SYSUTCDATETIME());
       END TRY
       BEGIN CATCH
         IF ERROR_NUMBER() NOT IN (2601, 2627) OR @dedupe_key IS NULL THROW;
         SELECT outbox_id
         FROM dbo.notification_outbox
         WHERE dedupe_key = @dedupe_key
           AND channel = @channel
           AND ((tenant_id = @tenant_id) OR (tenant_id IS NULL AND @tenant_id IS NULL));
       END CATCH`
    );

  const persistedId = result.recordset[0]?.outbox_id;
  if (!persistedId) {
    throw new Error('Notification outbox enqueue did not return an outbox id.');
  }
  return persistedId;
}

async function claimNotifications(batchSize: number, leaseMs: number): Promise<NotificationOutboxRow[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('batch_size', sql.Int, batchSize)
    .input('lease_ms', sql.Int, leaseMs)
    .query<NotificationOutboxRow>(
      `;WITH claimable AS (
         SELECT TOP (@batch_size) *
         FROM dbo.notification_outbox WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE (state = 'queued' AND available_at <= SYSUTCDATETIME())
          OR (state = 'processing' AND lease_expires_at <= SYSUTCDATETIME())
         ORDER BY available_at, created_at
       )
       UPDATE claimable
       SET state = 'processing',
           attempt_count = attempt_count + 1,
           lease_token = NEWID(),
           lease_expires_at = DATEADD(MILLISECOND, @lease_ms, SYSUTCDATETIME()),
           last_attempt_at = SYSUTCDATETIME(),
           updated_at = SYSUTCDATETIME()
       OUTPUT INSERTED.outbox_id, INSERTED.tenant_id, INSERTED.channel, INSERTED.payload,
              INSERTED.attempt_count, INSERTED.lease_token;`
    );
  return result.recordset;
}

async function markSent(row: NotificationOutboxRow, providerId?: string): Promise<void> {
  const pool = await getPool();
  await pool
    .request()
    .input('outbox_id', sql.UniqueIdentifier, row.outbox_id)
    .input('lease_token', sql.UniqueIdentifier, row.lease_token)
    .input('provider_id', sql.NVarChar(255), providerId ?? null)
    .query(
      `UPDATE dbo.notification_outbox
       SET state = 'sent', provider_id = @provider_id, provider_error = NULL,
           sent_at = SYSUTCDATETIME(), completed_at = SYSUTCDATETIME(),
           lease_token = NULL, lease_expires_at = NULL, updated_at = SYSUTCDATETIME()
       WHERE outbox_id = @outbox_id AND lease_token = @lease_token AND state = 'processing'`
    );
}

async function markFailed(
  row: NotificationOutboxRow,
  error: unknown,
  maxAttempts: number,
  retryBaseMs: number,
  retryMaxMs: number
): Promise<'retried' | 'dead_letter'> {
  const pool = await getPool();
  const deadLetter = row.attempt_count >= maxAttempts;
  const retryDelayMs = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.max(0, row.attempt_count - 1)));
  const errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, 4000);
  await pool
    .request()
    .input('outbox_id', sql.UniqueIdentifier, row.outbox_id)
    .input('lease_token', sql.UniqueIdentifier, row.lease_token)
    .input('state', sql.NVarChar(20), deadLetter ? 'dead_letter' : 'queued')
    .input('provider_error', sql.NVarChar(4000), errorMessage)
    .input('retry_delay_ms', sql.Int, retryDelayMs)
    .query(
      `UPDATE dbo.notification_outbox
       SET state = @state,
           provider_error = @provider_error,
           available_at = CASE WHEN @state = 'queued'
             THEN DATEADD(MILLISECOND, @retry_delay_ms, SYSUTCDATETIME()) ELSE available_at END,
           dead_lettered_at = CASE WHEN @state = 'dead_letter' THEN SYSUTCDATETIME() ELSE NULL END,
           completed_at = CASE WHEN @state = 'dead_letter' THEN SYSUTCDATETIME() ELSE NULL END,
           lease_token = NULL, lease_expires_at = NULL, updated_at = SYSUTCDATETIME()
       WHERE outbox_id = @outbox_id AND lease_token = @lease_token AND state = 'processing'`
    );
  return deadLetter ? 'dead_letter' : 'retried';
}

async function runNotificationOutboxWorker(
  dispatcher: NotificationOutboxDispatcher,
  options: RunNotificationOutboxOptions = {}
): Promise<NotificationOutboxRunResult> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  const rows = await claimNotifications(batchSize, leaseMs);
  const result = { claimed: rows.length, sent: 0, retried: 0, deadLettered: 0 };

  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as OutboxPayload;
      const providerId = row.channel === 'email'
        ? await dispatcher.deliverOutboxEmail(payload)
        : await dispatcher.deliverOutboxSms(payload);
      await markSent(row, providerId);
      result.sent += 1;
    } catch (error) {
      const outcome = await markFailed(row, error, maxAttempts, retryBaseMs, retryMaxMs);
      if (outcome === 'dead_letter') {
        result.deadLettered += 1;
      } else {
        result.retried += 1;
      }
    }
  }

  return result;
}

export { createNotificationDedupeKey, enqueueNotification, runNotificationOutboxWorker };
export type {
  EnqueueNotificationOptions,
  NotificationOutboxDispatcher,
  NotificationOutboxRunResult,
  OutboxChannel,
  OutboxPayload,
  RunNotificationOutboxOptions,
};