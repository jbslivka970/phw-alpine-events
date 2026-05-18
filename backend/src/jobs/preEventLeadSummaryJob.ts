import {
  claimDuePreEventLeadSummaryEvents,
  markPreEventLeadSummarySent,
  releasePreEventLeadSummaryClaim,
} from '../services/eventEmailWorkflowService';
import { sendPreEventLeadSummaryEmail } from '../services/eventSummaryEmailService';

async function runPreEventLeadSummaryJob(lookAheadHours = 72): Promise<void> {
  const claimed = await claimDuePreEventLeadSummaryEvents(lookAheadHours);

  let attempted = 0;
  let delivered = 0;
  let failed = 0;

  for (const row of claimed) {
    attempted += 1;
    try {
      await sendPreEventLeadSummaryEmail({
        eventId: row.eventId,
        actor: 'system',
        operationReason: `auto_lookahead_${lookAheadHours}h`,
      });
      await markPreEventLeadSummarySent(row.eventId, row.claimToken);
      delivered += 1;
    } catch (error) {
      await releasePreEventLeadSummaryClaim(row.eventId, row.claimToken);
      failed += 1;
      console.error('[preEventLeadSummaryJob] failed to send lead prep summary', {
        eventId: row.eventId,
        error,
      });
    }
  }

  console.log(JSON.stringify({
    level: 'info',
    event: 'pre_event_lead_summary_job_completed',
    lookAheadHours,
    attempted,
    delivered,
    failed,
    timestamp: new Date().toISOString(),
  }));
}

if (require.main === module) {
  runPreEventLeadSummaryJob().catch((error) => {
    console.error('Pre-event lead summary job failed', error);
    process.exit(1);
  });
}

export { runPreEventLeadSummaryJob };