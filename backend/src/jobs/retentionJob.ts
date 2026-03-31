import { getPool, sql } from '../db';

type RetentionTarget = {
  label: 'notification_log' | 'inbound_sms_log' | 'email_preference_log';
  tableName: 'notification_log' | 'inbound_sms_log' | 'email_preference_log';
  dateColumn: 'sent_at' | 'received_at' | 'recorded_at';
  retentionDays: number;
};

type RetentionRunOptions = {
  dryRun?: boolean;
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

function resolveOptions(overrides?: RetentionRunOptions): { dryRun: boolean; targets: RetentionTarget[] } {
  const dryRun = overrides?.dryRun ?? /^(1|true|yes|on)$/i.test(process.env['RETENTION_DRY_RUN'] ?? 'false');
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

  return { dryRun, targets };
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

async function deleteCandidates(target: RetentionTarget): Promise<number> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('retention_days', sql.Int, target.retentionDays)
    .query<{ deleted_count: number }>(
      `DELETE FROM ${target.tableName}
       WHERE ${target.dateColumn} < DATEADD(day, -@retention_days, GETUTCDATE());
       SELECT @@ROWCOUNT AS deleted_count;`
    );

  return result.recordset[0]?.deleted_count ?? 0;
}

async function runRetentionJob(overrides?: RetentionRunOptions): Promise<RetentionResult[]> {
  const { dryRun, targets } = resolveOptions(overrides);
  const enabledTargets = targets.filter((target) => target.retentionDays > 0);
  const results: RetentionResult[] = [];

  for (const target of enabledTargets) {
    const affectedRows = dryRun
      ? await countCandidates(target)
      : await deleteCandidates(target);

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
