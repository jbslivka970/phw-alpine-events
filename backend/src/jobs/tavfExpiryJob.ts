import { getPool, sql } from '../db';

async function runTavfExpiryJob(): Promise<number> {
  const pool = await getPool();
  const result = await pool
    .request()
    .query(
      `UPDATE tavf_posting
       SET status = 'cancelled',
           updated_at = GETDATE()
       WHERE status = 'open'
         AND created_at < DATEADD(day, -30, GETDATE())`
    );

  const expiredCount = result.rowsAffected[0] ?? 0;
  console.log(`[tavfExpiryJob] Expired postings: ${expiredCount}`);
  return expiredCount;
}

if (require.main === module) {
  runTavfExpiryJob().catch((error) => {
    console.error('[tavfExpiryJob] failed', error);
    process.exit(1);
  });
}

export { runTavfExpiryJob };
