# Notification outbox

The notification outbox makes scheduled reminder delivery durable without changing the existing synchronous notification API.

## Durability boundary

- `NotificationService.sendEmail` and `NotificationService.sendSms` remain synchronous compatibility APIs. Existing transactional call sites still attempt provider delivery before returning.
- `NotificationService.enqueueEmail` and `NotificationService.enqueueSms` persist provider-ready payloads in `dbo.notification_outbox` and return only after SQL accepts the row.
- `runReminderJob` uses the durable methods. Its `event_response.reminder_sent` flag means all eligible reminder channels were accepted by the outbox, not that a provider has delivered them.
- Other notification call sites remain synchronous. They can move to the explicit enqueue methods when their owning transaction or workflow is ready to treat SQL acceptance as success.

The worker invokes the existing notification service delivery path, so channel policy, consent checks, test-traffic guards, provider calls, and `notification_log` auditing remain centralized.

## Processing

The scheduler runs the `notification-outbox` job under the existing distributed job lease. Each batch atomically claims rows with SQL Server `UPDLOCK`, `READPAST`, and `ROWLOCK`; row lease tokens guard all completion updates. Expired processing leases are reclaimable.

Provider failures use bounded exponential backoff. The defaults are five attempts, a 30-second initial delay, and a one-hour delay cap. A final failure moves the row to `dead_letter`. Successful and dead-letter rows record provider/error and completion timestamps.

`NOTIFICATION_OUTBOX_INTERVAL_MS` controls the polling interval and defaults to 10 seconds. Process shutdown clears the polling timer; an interrupted row becomes eligible again when its row lease expires.

## Tenant policy

In multi-tenant mode (`MULTI_TENANT_ENABLED=true`), delivery fails closed when the tenant cannot be resolved, the tenant messaging toggle columns are unavailable, the tenant policy row is missing, policy lookup fails, or the selected channel is disabled. Single-tenant mode preserves the previous enabled fallback.

## Retention

Completed outbox rows participate in the existing retention job. `RETENTION_NOTIFICATION_OUTBOX_DAYS` defaults to 30 days. As with the other retention targets, deletion requires retention delete mode and explicit confirmation; queued and processing rows have no `completed_at` value and are not deleted.