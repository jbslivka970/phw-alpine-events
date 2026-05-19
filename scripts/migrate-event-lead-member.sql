-- Migration: replace event.event_lead_name / event.event_lead_email with
-- event.event_lead_member_id (FK to member). Idempotent — safe to re-run.
-- allow-breaking-migration: DROP_COLUMN
--
-- Run via: MIGRATION_DB_PASSWORD=... node scripts/run-event-lead-migration.js
--
-- NOTE: there is no backfill. Per the agreed plan, the small number of open
-- events will be re-assigned manually via the new picker UI after deploy.

SET XACT_ABORT ON;
SET NOCOUNT ON;

BEGIN TRANSACTION;

-- 1. Add the FK column if missing.
IF COL_LENGTH('dbo.event', 'event_lead_member_id') IS NULL
BEGIN
    ALTER TABLE dbo.event ADD event_lead_member_id UNIQUEIDENTIFIER NULL;
END;

-- 2. Add the FK constraint if missing.
IF NOT EXISTS (
    SELECT 1
    FROM sys.foreign_keys
    WHERE name = N'FK_event_event_lead_member'
      AND parent_object_id = OBJECT_ID(N'dbo.event')
)
BEGIN
    ALTER TABLE dbo.event
    ADD CONSTRAINT FK_event_event_lead_member FOREIGN KEY (event_lead_member_id)
        REFERENCES dbo.member (member_id);
END;

-- 3. Drop the legacy free-text columns if still present.
IF COL_LENGTH('dbo.event', 'event_lead_name') IS NOT NULL
BEGIN
    ALTER TABLE dbo.event DROP COLUMN event_lead_name;
END;

IF COL_LENGTH('dbo.event', 'event_lead_email') IS NOT NULL
BEGIN
    ALTER TABLE dbo.event DROP COLUMN event_lead_email;
END;

COMMIT TRANSACTION;

-- Post-run report.
SELECT
    CASE WHEN COL_LENGTH('dbo.event', 'event_lead_member_id') IS NULL THEN 0 ELSE 1 END AS has_event_lead_member_id,
    CASE WHEN COL_LENGTH('dbo.event', 'event_lead_name')      IS NULL THEN 0 ELSE 1 END AS has_event_lead_name,
    CASE WHEN COL_LENGTH('dbo.event', 'event_lead_email')     IS NULL THEN 0 ELSE 1 END AS has_event_lead_email,
    (SELECT COUNT(*) FROM sys.foreign_keys
     WHERE name = N'FK_event_event_lead_member'
       AND parent_object_id = OBJECT_ID(N'dbo.event')) AS has_fk_event_lead_member;
