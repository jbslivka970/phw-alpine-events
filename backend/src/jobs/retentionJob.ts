import { getPool, sql } from '../db';

type RetentionTarget = {
  label: 'notification_log' | 'inbound_sms_log' | 'email_preference_log';
  tableName: 'notification_log' | 'inbound_sms_log' | 'email_preference_log';
  dateColumn: 'sent_at' | 'received_at' | 'recorded_at';
  retentionDays: number;
};

type RetentionRunOptions = {
  dryRun?: boolean;
  confirmDelete?: boolean;
  maxDeletePerTarget?: number;
  deleteBatchSize?: number;
  notificationLogDays?: number;
  inboundSmsLogDays?: number;
  emailPreferenceLogDays?: number;
};

type RetentionResult = {
  target: RetentionTarget['label'];
  retentionDays: number;
  affectedRows: number;
  mode: 'dry-run' | 'delete';
};

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveOptions(overrides?: RetentionRunOptions): {
  dryRun: boolean;
  maxDeletePerTarget: number;
  deleteBatchSize: number;
  targets: RetentionTarget[];
} {
  const requestedDryRun = overrides?.dryRun ?? /^(1|true|yes|on)$/i.test(process.env['RETENTION_DRY_RUN'] ?? 'false');
  const confirmDelete = overrides?.confirmDelete ?? /^(1|true|yes|on)$/i.test(process.env['RETENTION_CONFIRM_DELETE'] ?? 'false');
  const maxDeletePerTarget = overrides?.maxDeletePerTarget ?? parsePositiveInt(process.env['RETENTION_MAX_DELETE_PER_TARGET'], 50000);
  const deleteBatchSize = overrides?.deleteBatchSize ?? parsePositiveInt(process.env['RETENTION_DELETE_BATCH_SIZE'], 5000);

  const dryRun = requestedDryRun || !confirmDelete;
  if (!requestedDryRun && !confirmDelete) {
    console.warn('[retentionJob] Delete mode requested without RETENTION_CONFIRM_DELETE=true. Running in dry-run mode.');
  }

  const notificationLogDays = overrides?.notificationLogDays ?? parsePositiveInt(process.env['RETENTION_NOTIFICATION_LOG_DAYS'], 180);
  const inboundSmsLogDays = overrides?.inboundSmsLogDays ?? parsePositiveInt(process.env['RETENTION_INBOUND_SMS_LOG_DAYS'], 365);
  const emailPreferenceLogDays = overrides?.emailPreferenceLogDays ?? parsePositiveInt(process.env['RETENTION_EMAIL_PREFERENCE_LOG_DAYS'], 365);

  const targets: RetentionTarget[] = [
    {
      label: 'notification_log',
      tableName: 'notification_log',
      dateColumn: 'sent_at',
      retentionDays: notificationLogDays,
    },
    {
      label: 'inbound_sms_log',
      tableName: 'inbound_sms_log',
      dateColumn: 'received_at',
      retentionDays: inboundSmsLogDays,
    },
    {
      label: 'email_preference_log',
      tableName: 'email_preference_log',
      dateColumn: 'recorded_at',
      retentionDays: emailPreferenceLogDays,
    },
  ];

  return { dryRun, maxDeletePerTarget, deleteBatchSize, targets };
}

async function countCandidates(target: RetentionTarget): Promise<number> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('retention_days', sql.Int, target.retentionDays)
    .query<{ count_to_delete: number }>(
      `SELECT COUNT(*) AS count_to_delete
       FROM ${target.tableName}
       WHERE ${target.dateColumn} < DATEADD(day, -@retention_days, GETUTCDATE())`
    );

  return result.recordset[0]?.count_to_delete ?? 0;
}

async function deleteCandidates(target: RetentionTarget, deleteBatchSize: number): Promise<number> {
  const pool = await getPool();
  let totalDeleted = 0;

  while (true) {
    const result = await pool
      .request()
      .input('retention_days', sql.Int, target.retentionDays)
      .input('delete_batch_size', sql.Int, deleteBatchSize)
      .query<{ deleted_count: number }>(
        `DELETE TOP (@delete_batch_size) FROM ${target.tableName}
         WHERE ${target.dateColumn} < DATEADD(day, -@retention_days, GETUTCDATE());
         SELECT @@ROWCOUNT AS deleted_count;`
      );

    const deletedCount = result.recordset[0]?.deleted_count ?? 0;
    totalDeleted += deletedCount;
    if (deletedCount < deleteBatchSize) {
      break;
    }
  }

  return totalDeleted;
}

async function runRetentionJob(overrides?: RetentionRunOptions): Promise<RetentionResult[]> {
  const { dryRun, maxDeletePerTarget, deleteBatchSize, targets } = resolveOptions(overrides);
  const enabledTargets = targets.filter((target) => target.retentionDays > 0);
  const results: RetentionResult[] = [];

  for (const target of enabledTargets) {
    let affectedRows = 0;
    if (dryRun) {
      affectedRows = await countCandidates(target);
    } else {
      const candidates = await countCandidates(target);
      if (maxDeletePerTarget > 0 && candidates > maxDeletePerTarget) {
        throw new Error(
          `[retentionJob] ${target.label} candidate count ${candidates} exceeds RETENTION_MAX_DELETE_PER_TARGET=${maxDeletePerTarget}. Reduce scope or increase the limit intentionally.`
        );
      }

      affectedRows = candidates === 0
        ? 0
        : await deleteCandidates(target, deleteBatchSize);
    }

    results.push({
      target: target.label,
      retentionDays: target.retentionDays,
      affectedRows,
      mode: dryRun ? 'dry-run' : 'delete',
    });
  }

  console.log(JSON.stringify({
    level: 'info',
    event: 'retention_job_completed',
    mode: dryRun ? 'dry-run' : 'delete',
    deleteBatchSize,
    results,
    timestamp: new Date().toISOString(),
  }));

  return results;
}

export { runRetentionJob };
export type { RetentionResult, RetentionRunOptions };

if (require.main === module) {
  runRetentionJob()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      console.error('[retentionJob] failed', error);
      process.exit(1);
    });
}
