/*
  V2 P0 + P2 production migration
  - Ensure event columns exist everywhere
  - Merge legacy MENTORS group into VOLUNTEERS
  - Remove RollOutTest group
  - Add helpful notification log index for publish cooldown checks

  Safe to run multiple times.
*/

SET XACT_ABORT ON;
BEGIN TRANSACTION;

-- P0: Ensure event columns exist.
IF COL_LENGTH('dbo.event', 'photo_url') IS NULL
    ALTER TABLE dbo.event ADD photo_url NVARCHAR(1024) NULL;

IF COL_LENGTH('dbo.event', 'invitation_stage') IS NULL
BEGIN
    ALTER TABLE dbo.event ADD invitation_stage NVARCHAR(20) NOT NULL CONSTRAINT DF_event_invitation_stage_v2 DEFAULT 'both';
END;

IF COL_LENGTH('dbo.event', 'event_lead_name') IS NULL
    ALTER TABLE dbo.event ADD event_lead_name NVARCHAR(200) NULL;

IF COL_LENGTH('dbo.event', 'event_lead_email') IS NULL
    ALTER TABLE dbo.event ADD event_lead_email NVARCHAR(255) NULL;

-- Keep invitation_stage constrained.
IF NOT EXISTS (
    SELECT 1
    FROM sys.check_constraints
    WHERE name = N'CK_event_invitation_stage'
      AND parent_object_id = OBJECT_ID(N'dbo.event')
)
BEGIN
    ALTER TABLE dbo.event
    ADD CONSTRAINT CK_event_invitation_stage
        CHECK (invitation_stage IN ('volunteer', 'participant', 'both'));
END;

UPDATE dbo.event
SET invitation_stage = 'both'
WHERE invitation_stage IS NULL;

-- P2: Merge MENTORS into VOLUNTEERS, then delete MENTORS.
DECLARE @mentors_group_id UNIQUEIDENTIFIER;
DECLARE @volunteers_group_id UNIQUEIDENTIFIER;

SELECT @mentors_group_id = group_id
FROM dbo.[group]
WHERE group_name = 'MENTORS';

SELECT @volunteers_group_id = group_id
FROM dbo.[group]
WHERE group_name = 'VOLUNTEERS';

IF @mentors_group_id IS NOT NULL
BEGIN
    IF @volunteers_group_id IS NULL
    BEGIN
        SET @volunteers_group_id = NEWID();
        INSERT INTO dbo.[group] (group_id, group_name, description, is_system)
        VALUES (@volunteers_group_id, 'VOLUNTEERS', 'Volunteers / guides', 1);
    END;

    UPDATE mg
    SET mg.group_id = @volunteers_group_id
    FROM dbo.member_group mg
    WHERE mg.group_id = @mentors_group_id
      AND NOT EXISTS (
          SELECT 1
          FROM dbo.member_group existing
          WHERE existing.member_id = mg.member_id
            AND existing.group_id = @volunteers_group_id
      );

    DELETE FROM dbo.member_group
    WHERE group_id = @mentors_group_id;

    UPDATE dbo.event_notification_target
    SET group_id = @volunteers_group_id
    WHERE group_id = @mentors_group_id;

    DELETE FROM dbo.[group]
    WHERE group_id = @mentors_group_id;
END;

-- P2: Remove rollout test group.
DECLARE @rollout_group_id UNIQUEIDENTIFIER;
SELECT @rollout_group_id = group_id
FROM dbo.[group]
WHERE group_name = 'RollOutTest';

IF @rollout_group_id IS NOT NULL
BEGIN
    DELETE FROM dbo.event_notification_target WHERE group_id = @rollout_group_id;
    DELETE FROM dbo.member_group WHERE group_id = @rollout_group_id;
    DELETE FROM dbo.[group] WHERE group_id = @rollout_group_id;
END;

-- P3 helper index for fast publish cooldown lookups.
IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = N'IX_notification_log_event_operation_sent_at'
      AND object_id = OBJECT_ID(N'dbo.notification_log')
)
BEGIN
    CREATE INDEX IX_notification_log_event_operation_sent_at
    ON dbo.notification_log (event_id, operation_type, status, sent_at DESC);
END;

COMMIT TRANSACTION;

-- Post-run checks
SELECT
  has_photo_url = COL_LENGTH('dbo.event', 'photo_url'),
  has_invitation_stage = COL_LENGTH('dbo.event', 'invitation_stage'),
  has_event_lead_name = COL_LENGTH('dbo.event', 'event_lead_name'),
  has_event_lead_email = COL_LENGTH('dbo.event', 'event_lead_email');

SELECT group_name, COUNT(*) AS member_links
FROM dbo.[group] g
LEFT JOIN dbo.member_group mg ON mg.group_id = g.group_id
WHERE g.group_name IN ('VOLUNTEERS', 'MENTORS', 'RollOutTest')
GROUP BY group_name;
