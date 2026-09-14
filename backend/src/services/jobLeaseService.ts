import { randomUUID } from 'node:crypto';
import { getPool, sql } from '../db';

const ownerId = process.env['WEBSITE_INSTANCE_ID']?.trim() || `${process.pid}:${randomUUID()}`;

interface LeaseRow {
  lease_token: string;
}

async function tryAcquireJobLease(jobName: string, leaseMs: number): Promise<string | null> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('job_name', sql.NVarChar(100), jobName)
    .input('owner_id', sql.NVarChar(200), ownerId)
    .input('lease_ms', sql.Int, leaseMs)
    .query<LeaseRow>(
      `DECLARE @lease_token UNIQUEIDENTIFIER = NEWID();
       MERGE dbo.job_lease WITH (HOLDLOCK) AS target
       USING (SELECT @job_name AS job_name) AS source
       ON target.job_name = source.job_name
       WHEN MATCHED AND target.lease_expires_at <= SYSUTCDATETIME() THEN
         UPDATE SET lease_token = @lease_token,
                    owner_id = @owner_id,
                    lease_expires_at = DATEADD(MILLISECOND, @lease_ms, SYSUTCDATETIME()),
                    heartbeat_at = SYSUTCDATETIME(),
                    last_started_at = SYSUTCDATETIME(),
                    last_status = 'running',
                    last_error = NULL
       WHEN NOT MATCHED THEN
         INSERT (job_name, lease_token, owner_id, lease_expires_at, heartbeat_at, last_started_at, last_status)
         VALUES (@job_name, @lease_token, @owner_id, DATEADD(MILLISECOND, @lease_ms, SYSUTCDATETIME()), SYSUTCDATETIME(), SYSUTCDATETIME(), 'running')
       OUTPUT INSERTED.lease_token;`
    );

  return result.recordset[0]?.lease_token ?? null;
}

async function renewJobLease(jobName: string, leaseToken: string, leaseMs: number): Promise<boolean> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('job_name', sql.NVarChar(100), jobName)
    .input('lease_token', sql.UniqueIdentifier, leaseToken)
    .input('lease_ms', sql.Int, leaseMs)
    .query(
      `UPDATE dbo.job_lease
       SET lease_expires_at = DATEADD(MILLISECOND, @lease_ms, SYSUTCDATETIME()),
           heartbeat_at = SYSUTCDATETIME()
       WHERE job_name = @job_name AND lease_token = @lease_token`
    );
  return (result.rowsAffected[0] ?? 0) === 1;
}

async function releaseJobLease(jobName: string, leaseToken: string, error?: unknown): Promise<void> {
  const errorMessage = error instanceof Error ? error.message.slice(0, 2000) : error ? String(error).slice(0, 2000) : null;
  const pool = await getPool();
  await pool
    .request()
    .input('job_name', sql.NVarChar(100), jobName)
    .input('lease_token', sql.UniqueIdentifier, leaseToken)
    .input('last_status', sql.NVarChar(20), error ? 'failed' : 'completed')
    .input('last_error', sql.NVarChar(2000), errorMessage)
    .query(
      `UPDATE dbo.job_lease
       SET lease_expires_at = SYSUTCDATETIME(),
           heartbeat_at = SYSUTCDATETIME(),
           last_finished_at = SYSUTCDATETIME(),
           last_status = @last_status,
           last_error = @last_error
       WHERE job_name = @job_name AND lease_token = @lease_token`
    );
}

async function runWithJobLease(jobName: string, job: () => Promise<unknown>, leaseMs = 15 * 60 * 1000): Promise<boolean> {
  const leaseToken = await tryAcquireJobLease(jobName, leaseMs);
  if (!leaseToken) {
    return false;
  }

  let jobError: unknown;
  const heartbeat = setInterval(() => {
    void renewJobLease(jobName, leaseToken, leaseMs).catch((error) => {
      console.error(`[scheduler] ${jobName} lease heartbeat failed`, error);
    });
  }, Math.max(5_000, Math.floor(leaseMs / 3)));

  try {
    await job();
    return true;
  } catch (error) {
    jobError = error;
    throw error;
  } finally {
    clearInterval(heartbeat);
    await releaseJobLease(jobName, leaseToken, jobError);
  }
}

export { releaseJobLease, renewJobLease, runWithJobLease, tryAcquireJobLease };