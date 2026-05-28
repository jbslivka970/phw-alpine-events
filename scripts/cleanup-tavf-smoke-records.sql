-- One-shot cleanup for smoke/e2e TAVF postings that should not exist in shared/prod data.
-- Safe-by-default: preview only. Set @apply = 1 to execute deletes.

SET NOCOUNT ON;

DECLARE @apply BIT = 0;

IF OBJECT_ID('tempdb..#target_postings') IS NOT NULL
    DROP TABLE #target_postings;

CREATE TABLE #target_postings (
    posting_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
    guide_member_id UNIQUEIDENTIFIER NOT NULL,
    event_date DATE NOT NULL,
    location NVARCHAR(500) NOT NULL,
    status NVARCHAR(20) NOT NULL,
    created_at DATETIME NOT NULL,
    matched_playwright BIT NOT NULL,
    matched_smoke_river BIT NOT NULL,
    matched_authz_smoke BIT NOT NULL,
    matched_contract_probe BIT NOT NULL,
    matched_e2e BIT NOT NULL
);

INSERT INTO #target_postings (
    posting_id,
    guide_member_id,
    event_date,
    location,
    status,
    created_at,
    matched_playwright,
    matched_smoke_river,
    matched_authz_smoke,
    matched_contract_probe,
    matched_e2e
)
SELECT
    p.posting_id,
    p.guide_member_id,
    p.event_date,
    p.location,
    p.status,
    p.created_at,
    CASE WHEN LOWER(COALESCE(p.location, '')) LIKE '%playwright%'
           OR LOWER(COALESCE(p.description, '')) LIKE '%playwright%'
         THEN 1 ELSE 0 END,
    CASE WHEN LOWER(COALESCE(p.location, '')) LIKE '%smoke river%'
           OR LOWER(COALESCE(p.description, '')) LIKE '%smoke river%'
         THEN 1 ELSE 0 END,
    CASE WHEN LOWER(COALESCE(p.location, '')) LIKE '%authz smoke%'
           OR LOWER(COALESCE(p.description, '')) LIKE '%authz smoke%'
         THEN 1 ELSE 0 END,
    CASE WHEN LOWER(COALESCE(p.location, '')) LIKE '%contract probe%'
           OR LOWER(COALESCE(p.description, '')) LIKE '%contract probe%'
         THEN 1 ELSE 0 END,
    CASE WHEN LOWER(COALESCE(p.location, '')) LIKE '%e2e%'
           OR LOWER(COALESCE(p.description, '')) LIKE '%e2e%'
         THEN 1 ELSE 0 END
FROM dbo.tavf_posting p
WHERE LOWER(COALESCE(p.location, '')) LIKE '%playwright%'
   OR LOWER(COALESCE(p.description, '')) LIKE '%playwright%'
   OR LOWER(COALESCE(p.location, '')) LIKE '%smoke river%'
   OR LOWER(COALESCE(p.description, '')) LIKE '%smoke river%'
   OR LOWER(COALESCE(p.location, '')) LIKE '%authz smoke%'
   OR LOWER(COALESCE(p.description, '')) LIKE '%authz smoke%'
   OR LOWER(COALESCE(p.location, '')) LIKE '%contract probe%'
   OR LOWER(COALESCE(p.description, '')) LIKE '%contract probe%'
   OR LOWER(COALESCE(p.location, '')) LIKE '%e2e%'
   OR LOWER(COALESCE(p.description, '')) LIKE '%e2e%';

SELECT
    (SELECT COUNT(*) FROM #target_postings) AS target_posting_count,
    (SELECT COUNT(*) FROM dbo.tavf_application WHERE posting_id IN (SELECT posting_id FROM #target_postings)) AS target_application_count,
    (SELECT COUNT(*) FROM dbo.tavf_match WHERE posting_id IN (SELECT posting_id FROM #target_postings)) AS target_match_count;

SELECT TOP (200)
    posting_id,
    guide_member_id,
    event_date,
    location,
    status,
    created_at,
    matched_playwright,
    matched_smoke_river,
    matched_authz_smoke,
    matched_contract_probe,
    matched_e2e
FROM #target_postings
ORDER BY created_at DESC;

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

    DELETE FROM dbo.tavf_posting
    WHERE posting_id IN (SELECT posting_id FROM #target_postings);

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
