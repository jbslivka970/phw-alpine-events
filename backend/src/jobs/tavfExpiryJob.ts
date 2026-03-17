/**
 * TAVF Expiry Job
 *
 * Marks tavf_posting records as 'cancelled' if they have been open for more
 * than 30 days without being filled.
 *
 * Run via: node dist/jobs/tavfExpiryJob.js
 */

import { getPool, sql } from '../db';

async function runTavfExpiryJob(): Promise<void> {
  console.log('[tavfExpiryJob] Starting TAVF posting expiry check...');

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .query<{ expired_count: number }>(
        `UPDATE tavf_posting
         SET status = 'cancelled', updated_at = GETDATE()
         WHERE status = 'open'
           AND created_at < DATEADD(day, -30, GETDATE());

         SELECT @@ROWCOUNT AS expired_count;`
      );

    const count = result.recordset[0]?.expired_count ?? 0;
    console.log(`[tavfExpiryJob] Expired ${count} posting(s).`);
  } catch (error) {
    console.error('[tavfExpiryJob] Error during expiry run:', error);
    process.exit(1);
  }

  process.exit(0);
}

runTavfExpiryJob().catch((err) => {
  console.error('[tavfExpiryJob] Unhandled error:', err);
  process.exit(1);
});
