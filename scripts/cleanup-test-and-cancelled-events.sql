-- One-shot cleanup for cancelled/test events in production.
-- Safe-by-default: preview only. Set @apply = 1 to execute deletes.

SET NOCOUNT ON;

DECLARE @apply BIT = 0;
DECLARE @include_status_cancelled BIT = 1;
DECLARE @include_status_canceled BIT = 1;
DECLARE @include_test_keyword BIT = 1;
DECLARE @include_uat_keyword BIT = 1;
DECLARE @include_qa_prefix BIT = 1;
DECLARE @include_smoke_prefix BIT = 1;
DECLARE @include_e2e_prefix BIT = 1;

IF OBJECT_ID('tempdb..#target_events') IS NOT NULL
    DROP TABLE #target_events;

CREATE TABLE #target_events (
    event_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    title NVARCHAR(255) NULL,
    status NVARCHAR(50) NULL,
    event_date DATETIME2 NULL,
    matched_by_status_cancelled BIT NOT NULL,
    matched_by_status_canceled BIT NOT NULL,
    matched_by_test_keyword BIT NOT NULL,
    matched_by_uat_keyword BIT NOT NULL,
    matched_by_qa_prefix BIT NOT NULL,
    matched_by_smoke_prefix BIT NOT NULL,
    matched_by_e2e_prefix BIT NOT NULL
);

INSERT INTO #target_events (
    event_id,
    title,
    status,
    event_date,
    matched_by_status_cancelled,
    matched_by_status_canceled,
    matched_by_test_keyword,
    matched_by_uat_keyword,
    matched_by_qa_prefix,
    matched_by_smoke_prefix,
    matched_by_e2e_prefix
)
SELECT
    e.event_id,
    e.title,
    e.status,
    e.event_date,
    CASE WHEN @include_status_cancelled = 1 AND n.status_norm = 'cancelled' THEN 1 ELSE 0 END,
    CASE WHEN @include_status_canceled = 1 AND n.status_norm = 'canceled' THEN 1 ELSE 0 END,
    CASE WHEN @include_test_keyword = 1
              AND (n.title_norm LIKE '%test%' OR n.description_norm LIKE '%test%' OR n.location_norm LIKE '%test%')
         THEN 1 ELSE 0 END,
    CASE WHEN @include_uat_keyword = 1
              AND (n.title_norm LIKE '%uat%' OR n.description_norm LIKE '%uat%' OR n.location_norm LIKE '%uat%')
         THEN 1 ELSE 0 END,
    CASE WHEN @include_qa_prefix = 1 AND n.title_norm LIKE 'qa%' THEN 1 ELSE 0 END,
    CASE WHEN @include_smoke_prefix = 1 AND n.title_norm LIKE 'smoke%' THEN 1 ELSE 0 END,
    CASE WHEN @include_e2e_prefix = 1 AND n.title_norm LIKE 'e2e%' THEN 1 ELSE 0 END
FROM dbo.event e
CROSS APPLY (
    SELECT
        LOWER(LTRIM(RTRIM(COALESCE(e.status, '')))) AS status_norm,
        LOWER(LTRIM(RTRIM(COALESCE(e.title, '')))) AS title_norm,
        LOWER(COALESCE(e.description, '')) AS description_norm,
        LOWER(COALESCE(e.location, '')) AS location_norm
) n
WHERE (@include_status_cancelled = 1 AND n.status_norm = 'cancelled')
   OR (@include_status_canceled = 1 AND n.status_norm = 'canceled')
   OR (@include_test_keyword = 1 AND (n.title_norm LIKE '%test%' OR n.description_norm LIKE '%test%' OR n.location_norm LIKE '%test%'))
   OR (@include_uat_keyword = 1 AND (n.title_norm LIKE '%uat%' OR n.description_norm LIKE '%uat%' OR n.location_norm LIKE '%uat%'))
   OR (@include_qa_prefix = 1 AND n.title_norm LIKE 'qa%')
   OR (@include_smoke_prefix = 1 AND n.title_norm LIKE 'smoke%')
   OR (@include_e2e_prefix = 1 AND n.title_norm LIKE 'e2e%');

IF OBJECT_ID('tempdb..#target_postings') IS NOT NULL
    DROP TABLE #target_postings;

CREATE TABLE #target_postings (
    posting_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY
);

INSERT INTO #target_postings (posting_id)
SELECT p.posting_id
FROM dbo.take_a_vet_posting p
WHERE p.event_id IN (SELECT event_id FROM #target_events);

SELECT
    (SELECT COUNT(*) FROM #target_events) AS target_event_count,
    (SELECT COUNT(*) FROM dbo.notification_log WHERE event_id IN (SELECT event_id FROM #target_events)) AS notification_log_count,
    (SELECT COUNT(*) FROM dbo.inbound_sms_log WHERE event_id IN (SELECT event_id FROM #target_events)) AS inbound_sms_log_count,
    (SELECT COUNT(*) FROM dbo.rsvp_short_link WHERE event_id IN (SELECT event_id FROM #target_events)) AS rsvp_short_link_count,
    (SELECT COUNT(*) FROM dbo.take_a_vet_posting WHERE event_id IN (SELECT event_id FROM #target_events)) AS tavf_posting_count,
    (SELECT COUNT(*) FROM dbo.event_response WHERE event_id IN (SELECT event_id FROM #target_events)) AS event_response_count,
    (SELECT COUNT(*) FROM dbo.event_assignment WHERE event_id IN (SELECT event_id FROM #target_events)) AS event_assignment_count,
    (SELECT COUNT(*) FROM dbo.event_guest_assignment WHERE event_id IN (SELECT event_id FROM #target_events)) AS event_guest_assignment_count,
    (SELECT COUNT(*) FROM dbo.event_email_workflow WHERE event_id IN (SELECT event_id FROM #target_events)) AS event_email_workflow_count,
    (SELECT COUNT(*) FROM dbo.waitlist_promotion_offer WHERE event_id IN (SELECT event_id FROM #target_events)) AS waitlist_offer_count;

SELECT TOP (200)
    event_id,
    title,
    status,
    event_date,
    matched_by_status_cancelled,
    matched_by_status_canceled,
    matched_by_test_keyword,
    matched_by_uat_keyword,
    matched_by_qa_prefix,
    matched_by_smoke_prefix,
    matched_by_e2e_prefix
FROM #target_events
ORDER BY event_date DESC;

IF @apply = 0
BEGIN
    PRINT 'Preview only. Set @apply = 1 and re-run to execute deletes.';
    RETURN;
END;

BEGIN TRY
    BEGIN TRAN;

    DELETE FROM dbo.tavf_match
    WHERE posting_id IN (SELECT posting_id FROM #target_postings);

    DELETE FROM dbo.tavf_application
    WHERE posting_id IN (SELECT posting_id FROM #target_postings);

    DELETE FROM dbo.take_a_vet_posting
    WHERE event_id IN (SELECT event_id FROM #target_events);

    DELETE FROM dbo.notification_log
    WHERE event_id IN (SELECT event_id FROM #target_events);

    DELETE FROM dbo.inbound_sms_log
    WHERE event_id IN (SELECT event_id FROM #target_events);

    DELETE FROM dbo.rsvp_short_link
    WHERE event_id IN (SELECT event_id FROM #target_events);

    DELETE FROM dbo.event
    WHERE event_id IN (SELECT event_id FROM #target_events);

    COMMIT TRAN;
    PRINT 'Cleanup committed.';
END TRY
BEGIN CATCH
    IF @@TRANCOUNT > 0
        ROLLBACK TRAN;
    THROW;
END CATCH;
