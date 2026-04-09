import { getPool, sql } from '../db';
import { triggerWaitlistAutoPromotion } from '../services/rsvpService';

interface WaitlistEventRow {
  event_id: string;
}

export async function runWaitlistLifecycleJob(): Promise<void> {
  const startedAt = Date.now();
  const pool = await getPool();

  const result = await pool
    .request()
    .query<WaitlistEventRow>(
      `SELECT DISTINCT e.event_id
       FROM event e
       WHERE e.status = 'published'
         AND (
           EXISTS (
             SELECT 1
             FROM event_response er
             WHERE er.event_id = e.event_id
               AND er.response = 'waitlist'
           )
           OR EXISTS (
             SELECT 1
             FROM waitlist_promotion_offer wpo
             WHERE wpo.event_id = e.event_id
               AND wpo.status = 'offered'
           )
         )`
    );

  const eventIds = result.recordset.map((row) => row.event_id);
  let processedCount = 0;
  let failedCount = 0;

  for (const eventId of eventIds) {
    try {
      await triggerWaitlistAutoPromotion(eventId);
      processedCount += 1;
    } catch (error) {
      failedCount += 1;
      console.error('[waitlistLifecycleJob] Failed to process event', { eventId, error });
    }
  }

  console.log(
    JSON.stringify({
      level: 'info',
      event: 'waitlist_lifecycle_job_completed',
      totalEvents: eventIds.length,
      processedCount,
      failedCount,
      durationMs: Date.now() - startedAt,
      timestamp: new Date().toISOString(),
    })
  );
}

