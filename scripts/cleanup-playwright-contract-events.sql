-- One-shot cleanup for Playwright/Contract test events in shared/prod data.
-- Safe-by-default: preview only. Set @apply = 1 to execute deletes.
-- Guardrails:
--   1) Script aborts if any matched row is not draft.
--   2) Script aborts if target count exceeds @max_target_events.

SET NOCOUNT ON;

DECLARE @apply BIT = 0;
DECLARE @max_target_events INT = 500;

IF OBJECT_ID('tempdb..#target_events') IS NOT NULL
    DROP TABLE #target_events;

CREATE TABLE #target_events (
    event_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    title NVARCHAR(255) NULL,
    status NVARCHAR(50) NULL,
    event_date DATETIME2 NULL,
    created_at DATETIME NULL,
    matched_playwright BIT NOT NULL,
    matched_contract_probe BIT NOT NULL,
    matched_role_matrix_contract BIT NOT NULL
);

INSERT INTO #target_events (
    event_id,
    title,
    status,
    event_date,
    created_at,
    matched_playwright,
    matched_contract_probe,
    matched_role_matrix_contract
)
SELECT
    e.event_id,
    e.title,
    e.status,
    e.event_date,
    e.created_at,
    CASE WHEN LOWER(COALESCE(e.title, '')) LIKE '%playwright%'
           OR LOWER(COALESCE(e.description, '')) LIKE '%playwright%'
           OR LOWER(COALESCE(e.location, '')) LIKE '%playwright%'
         THEN 1 ELSE 0 END,
    CASE WHEN LOWER(COALESCE(e.title, '')) LIKE '%contract probe%'
           OR LOWER(COALESCE(e.description, '')) LIKE '%contract probe%'
           OR LOWER(COALESCE(e.location, '')) LIKE '%contract probe%'
         THEN 1 ELSE 0 END,
    CASE WHEN LOWER(COALESCE(e.title, '')) LIKE '%role matrix contract%'
           OR LOWER(COALESCE(e.description, '')) LIKE '%role matrix contract%'
           OR LOWER(COALESCE(e.location, '')) LIKE '%role matrix contract%'
         THEN 1 ELSE 0 END
FROM dbo.event e
WHERE LOWER(COALESCE(e.title, '')) LIKE '%playwright%'
   OR LOWER(COALESCE(e.description, '')) LIKE '%playwright%'
   OR LOWER(COALESCE(e.location, '')) LIKE '%playwright%'
   OR LOWER(COALESCE(e.title, '')) LIKE '%contract probe%'
   OR LOWER(COALESCE(e.description, '')) LIKE '%contract probe%'
   OR LOWER(COALESCE(e.location, '')) LIKE '%contract probe%'
   OR LOWER(COALESCE(e.title, '')) LIKE '%role matrix contract%'
   OR LOWER(COALESCE(e.description, '')) LIKE '%role matrix contract%'
   OR LOWER(COALESCE(e.location, '')) LIKE '%role matrix contract%';

IF OBJECT_ID('tempdb..#target_postings') IS NOT NULL
    DROP TABLE #target_postings;

CREATE TABLE #target_postings (
    posting_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY
);

INSERT INTO #target_postings (posting_id)
SELECT p.posting_id
FROM dbo.take_a_vet_posting p
WHERE p.event_id IN (SELECT event_id FROM #target_events);

DECLARE @target_event_count INT = (SELECT COUNT(*) FROM #target_events);
DECLARE @non_draft_count INT = (
    SELECT COUNT(*)
    FROM #target_events
    WHERE LOWER(COALESCE(status, '')) <> 'draft'
);

SELECT
    @target_event_count AS target_event_count,
    @non_draft_count AS non_draft_target_count,
    (SELECT COUNT(*) FROM dbo.notification_log WHERE event_id IN (SELECT event_id FROM #target_events)) AS notification_log_count,
    (SELECT COUNT(*) FROM dbo.inbound_sms_log WHERE event_id IN (SELECT event_id FROM #target_events)) AS inbound_sms_log_count,
    (SELECT COUNT(*) FROM dbo.rsvp_short_link WHERE event_id IN (SELECT event_id FROM #target_events)) AS rsvp_short_link_count,
    (SELECT COUNT(*) FROM dbo.event_response WHERE event_id IN (SELECT event_id FROM #target_events)) AS event_response_count,
    (SELECT COUNT(*) FROM dbo.event_assignment WHERE event_id IN (SELECT event_id FROM #target_events)) AS event_assignment_count,
    (SELECT COUNT(*) FROM dbo.event_guest_assignment WHERE event_id IN (SELECT event_id FROM #target_events)) AS event_guest_assignment_count,
    (SELECT COUNT(*) FROM dbo.event_email_workflow WHERE event_id IN (SELECT event_id FROM #target_events)) AS event_email_workflow_count,
    (SELECT COUNT(*) FROM dbo.waitlist_promotion_offer WHERE event_id IN (SELECT event_id FROM #target_events)) AS waitlist_offer_count,
    (SELECT COUNT(*) FROM dbo.take_a_vet_posting WHERE event_id IN (SELECT event_id FROM #target_events)) AS tavf_posting_count,
    (SELECT COUNT(*) FROM dbo.tavf_application WHERE posting_id IN (SELECT posting_id FROM #target_postings)) AS tavf_application_count,
    (SELECT COUNT(*) FROM dbo.tavf_match WHERE posting_id IN (SELECT posting_id FROM #target_postings)) AS tavf_match_count;

SELECT TOP (200)
    event_id,
    title,
    status,
    event_date,
    created_at,
    matched_playwright,
    matched_contract_probe,
    matched_role_matrix_contract
FROM #target_events
ORDER BY event_date DESC, created_at DESC;

IF @target_event_count = 0
BEGIN
    PRINT 'No matching Playwright/Contract events found.';
    RETURN;
END;

IF @non_draft_count > 0
BEGIN
    RAISERROR('Guardrail triggered: one or more matched events are not draft. Refine criteria before apply.', 16, 1);
    RETURN;
END;

IF @target_event_count > @max_target_events
BEGIN
    RAISERROR('Guardrail triggered: target count exceeds @max_target_events. Refine criteria before apply.', 16, 1);
    RETURN;
END;

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

    DECLARE @msg NVARCHAR(4000) = ERROR_MESSAGE();
    DECLARE @severity INT = ERROR_SEVERITY();
    DECLARE @state INT = ERROR_STATE();
    RAISERROR('Cleanup failed: %s', @severity, @state, @msg);
END CATCH;
