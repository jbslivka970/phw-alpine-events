-- Azure SQL Database Schema for PHW Alpine Events
-- Based on PRD Section 5.1 Data Model
--
-- Implementation Notes:
--   - email is intentionally NOT unique to support households that share an email address.
--   - Idempotent guards (IF NOT EXISTS / IF OBJECT_ID IS NULL) allow re-running the script safely.
--   - All DATETIME columns use GETUTCDATE() so timestamps are UTC-normalized.
--   - Four system groups (ALL, ADMIN, MENTORS, PARTICIPANTS) are seeded at the bottom.

-- ---------------------------------------------------------------------------
-- 1. Member
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.member', N'U') IS NULL
CREATE TABLE dbo.member (
    member_id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    first_name         NVARCHAR(100)    NOT NULL,
    last_name          NVARCHAR(100)    NOT NULL,
    -- email is NOT unique: multiple members may share one household email address
    email              NVARCHAR(255)    NOT NULL,
    mobile_phone       NVARCHAR(20)     NULL,
    sms_opt_in         BIT              NOT NULL DEFAULT 0,
    sms_opt_in_date    DATETIME         NULL,
    sms_opt_out_date   DATETIME         NULL,
    email_opt_out      BIT              NOT NULL DEFAULT 0,
    salutation         NVARCHAR(50)     NULL,
    title              NVARCHAR(100)    NULL,
    account_name       NVARCHAR(200)    NULL,
    source             NVARCHAR(10)     NULL CHECK (source IN ('import', 'manual')),
    last_import_hash   NVARCHAR(64)     NULL,
    last_manual_edit   DATETIME         NULL,
    is_active          BIT              NOT NULL DEFAULT 1,
    created_at         DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    updated_at         DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT PK_member PRIMARY KEY (member_id)
);

-- ---------------------------------------------------------------------------
-- 2. [group]  (brackets required: GROUP is a reserved word in T-SQL)
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.[group]', N'U') IS NULL
CREATE TABLE dbo.[group] (
    group_id    UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    group_name  NVARCHAR(100)    NOT NULL,
    description NVARCHAR(500)    NULL,
    is_system   BIT              NOT NULL DEFAULT 0,  -- 1 = built-in / cannot be deleted
    created_at  DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT PK_group       PRIMARY KEY (group_id),
    CONSTRAINT UQ_group_name  UNIQUE      (group_name)
);

-- ---------------------------------------------------------------------------
-- 3. MemberGroup  (many-to-many: member <-> group)
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.member_group', N'U') IS NULL
CREATE TABLE dbo.member_group (
    member_group_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    member_id       UNIQUEIDENTIFIER NOT NULL,
    group_id        UNIQUEIDENTIFIER NOT NULL,
    added_at        DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT PK_member_group          PRIMARY KEY (member_group_id),
    CONSTRAINT UQ_member_group_pair     UNIQUE      (member_id, group_id),
    CONSTRAINT FK_member_group_member   FOREIGN KEY (member_id)
        REFERENCES dbo.member (member_id) ON DELETE CASCADE,
    CONSTRAINT FK_member_group_group    FOREIGN KEY (group_id)
        REFERENCES dbo.[group] (group_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 4. Event
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.event', N'U') IS NULL
CREATE TABLE dbo.event (
    event_id          UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    title             NVARCHAR(200)    NOT NULL,
    description       NVARCHAR(MAX)    NULL,
    location          NVARCHAR(300)    NULL,
    photo_url         NVARCHAR(1024)   NULL,
    event_date        DATETIME         NOT NULL,
    end_date          DATETIME         NULL,
    mentor_capacity   INT              NULL,
    participant_capacity INT           NULL,
    capacity          INT              NULL,
    status            NVARCHAR(20)     NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'published', 'cancelled', 'completed')),
    created_by        UNIQUEIDENTIFIER NULL,  -- FK to dbo.[user] added after that table is created
    created_at        DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    updated_at        DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT PK_event PRIMARY KEY (event_id)
);

IF OBJECT_ID(N'dbo.event', N'U') IS NOT NULL
BEGIN
    IF COL_LENGTH('dbo.event', 'mentor_capacity') IS NULL
        ALTER TABLE dbo.event ADD mentor_capacity INT NULL;

    IF COL_LENGTH('dbo.event', 'participant_capacity') IS NULL
        ALTER TABLE dbo.event ADD participant_capacity INT NULL;

    IF COL_LENGTH('dbo.event', 'photo_url') IS NULL
        ALTER TABLE dbo.event ADD photo_url NVARCHAR(1024) NULL;

        EXEC sp_executesql N'
                UPDATE dbo.event
                SET participant_capacity = capacity
                WHERE participant_capacity IS NULL
                    AND mentor_capacity IS NULL
                    AND capacity IS NOT NULL;

                UPDATE dbo.event
                SET capacity = COALESCE(mentor_capacity, 0) + COALESCE(participant_capacity, 0)
                WHERE mentor_capacity IS NOT NULL
                     OR participant_capacity IS NOT NULL;

                UPDATE dbo.event
                SET capacity = NULL
                WHERE COALESCE(mentor_capacity, 0) + COALESCE(participant_capacity, 0) = 0;
        ';
END

-- ---------------------------------------------------------------------------
-- 5. EventNotificationTarget  (which groups / members receive notifications)
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.event_notification_target', N'U') IS NULL
CREATE TABLE dbo.event_notification_target (
    target_id   UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    event_id    UNIQUEIDENTIFIER NOT NULL,
    -- Either group_id or member_id must be set, not both
    group_id    UNIQUEIDENTIFIER NULL,
    member_id   UNIQUEIDENTIFIER NULL,
    CONSTRAINT PK_event_notification_target        PRIMARY KEY (target_id),
    CONSTRAINT CK_ent_group_or_member              CHECK (
        (group_id IS NOT NULL AND member_id IS NULL) OR
        (group_id IS NULL     AND member_id IS NOT NULL)
    ),
    CONSTRAINT FK_ent_event     FOREIGN KEY (event_id)
        REFERENCES dbo.event  (event_id) ON DELETE CASCADE,
    CONSTRAINT FK_ent_group     FOREIGN KEY (group_id)
        REFERENCES dbo.[group] (group_id),
    CONSTRAINT FK_ent_member    FOREIGN KEY (member_id)
        REFERENCES dbo.member  (member_id)
);

-- ---------------------------------------------------------------------------
-- 6. EventResponse  (RSVP)
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.event_response', N'U') IS NULL
CREATE TABLE dbo.event_response (
    response_id   UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    event_id      UNIQUEIDENTIFIER NOT NULL,
    member_id     UNIQUEIDENTIFIER NOT NULL,
    group_context_id UNIQUEIDENTIFIER NULL,
    response_channel NVARCHAR(30) NULL,
    response      NVARCHAR(20)     NOT NULL
        CHECK (response IN ('yes', 'no', 'maybe', 'waitlist')),
    response_role NVARCHAR(20)     NOT NULL DEFAULT 'PARTICIPANT'
        CHECK (response_role IN ('MENTOR', 'PARTICIPANT')),
    responded_at  DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    notes         NVARCHAR(500)    NULL,
    reminder_sent BIT              NOT NULL DEFAULT 0,
    reminder_sent_at DATETIME      NULL,
    reminder_claimed_at DATETIME   NULL,
    reminder_claim_token UNIQUEIDENTIFIER NULL,
    CONSTRAINT PK_event_response            PRIMARY KEY (response_id),
    CONSTRAINT UQ_event_response_pair       UNIQUE      (event_id, member_id),
    CONSTRAINT FK_event_response_event      FOREIGN KEY (event_id)
        REFERENCES dbo.event  (event_id) ON DELETE CASCADE,
    CONSTRAINT FK_event_response_member     FOREIGN KEY (member_id)
        REFERENCES dbo.member (member_id)
        ON DELETE NO ACTION,
    CONSTRAINT FK_event_response_group_context FOREIGN KEY (group_context_id)
        REFERENCES dbo.[group] (group_id)
);

IF OBJECT_ID(N'dbo.event_response', N'U') IS NOT NULL
BEGIN
    IF COL_LENGTH('dbo.event_response', 'group_context_id') IS NULL
        ALTER TABLE dbo.event_response ADD group_context_id UNIQUEIDENTIFIER NULL;

    IF COL_LENGTH('dbo.event_response', 'response_channel') IS NULL
        ALTER TABLE dbo.event_response ADD response_channel NVARCHAR(30) NULL;

    IF COL_LENGTH('dbo.event_response', 'response_role') IS NULL
        ALTER TABLE dbo.event_response ADD response_role NVARCHAR(20) NOT NULL DEFAULT 'PARTICIPANT';

    IF COL_LENGTH('dbo.event_response', 'reminder_sent') IS NULL
        ALTER TABLE dbo.event_response ADD reminder_sent BIT NOT NULL DEFAULT 0;

    IF COL_LENGTH('dbo.event_response', 'reminder_sent_at') IS NULL
        ALTER TABLE dbo.event_response ADD reminder_sent_at DATETIME NULL;

    IF COL_LENGTH('dbo.event_response', 'reminder_claimed_at') IS NULL
        ALTER TABLE dbo.event_response ADD reminder_claimed_at DATETIME NULL;

    IF COL_LENGTH('dbo.event_response', 'reminder_claim_token') IS NULL
        ALTER TABLE dbo.event_response ADD reminder_claim_token UNIQUEIDENTIFIER NULL;

    IF NOT EXISTS (
      SELECT 1
      FROM sys.foreign_keys
      WHERE name = 'FK_event_response_group_context'
        AND parent_object_id = OBJECT_ID('dbo.event_response')
    )
        ALTER TABLE dbo.event_response
        ADD CONSTRAINT FK_event_response_group_context FOREIGN KEY (group_context_id)
        REFERENCES dbo.[group] (group_id);

    IF NOT EXISTS (
        SELECT 1
        FROM sys.check_constraints
        WHERE name = N'CK_event_response_response_role'
          AND parent_object_id = OBJECT_ID(N'dbo.event_response')
    )
        EXEC sp_executesql N'
            ALTER TABLE dbo.event_response
            ADD CONSTRAINT CK_event_response_response_role
                CHECK (response_role IN (''MENTOR'', ''PARTICIPANT''));
        ';
END

-- ---------------------------------------------------------------------------
-- 7. EventAssignment  (staff / volunteer role assignments for an event)
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.event_assignment', N'U') IS NULL
CREATE TABLE dbo.event_assignment (
    assignment_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    event_id      UNIQUEIDENTIFIER NOT NULL,
    member_id     UNIQUEIDENTIFIER NOT NULL,
    role          NVARCHAR(100)    NOT NULL,
    assigned_at   DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    notes         NVARCHAR(500)    NULL,
    CONSTRAINT PK_event_assignment           PRIMARY KEY (assignment_id),
    CONSTRAINT UQ_event_assignment_pair      UNIQUE      (event_id, member_id, role),
    CONSTRAINT FK_event_assignment_event     FOREIGN KEY (event_id)
        REFERENCES dbo.event  (event_id) ON DELETE CASCADE,
    CONSTRAINT FK_event_assignment_member    FOREIGN KEY (member_id)
        REFERENCES dbo.member (member_id)
);

IF OBJECT_ID(N'dbo.event_assignment', N'U') IS NOT NULL
BEGIN
    IF COL_LENGTH('dbo.event_assignment', 'attended') IS NULL
        ALTER TABLE dbo.event_assignment ADD attended BIT NOT NULL DEFAULT 0;

    IF COL_LENGTH('dbo.event_assignment', 'attendance_notes') IS NULL
        ALTER TABLE dbo.event_assignment ADD attendance_notes NVARCHAR(500) NULL;
END

-- ---------------------------------------------------------------------------
-- 8. NotificationTemplate
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.notification_template', N'U') IS NULL
CREATE TABLE dbo.notification_template (
    template_id   UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    template_name NVARCHAR(100)    NOT NULL,
    channel       NVARCHAR(10)     NOT NULL CHECK (channel IN ('email', 'sms')),
    subject       NVARCHAR(300)    NULL,   -- email only
    body          NVARCHAR(MAX)    NOT NULL,
    is_active     BIT              NOT NULL DEFAULT 1,
    created_at    DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    updated_at    DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT PK_notification_template        PRIMARY KEY (template_id),
    CONSTRAINT UQ_notification_template_name   UNIQUE      (template_name, channel)
);

IF OBJECT_ID(N'dbo.notification_template_version', N'U') IS NULL
CREATE TABLE dbo.notification_template_version (
    version_id     UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    template_id    UNIQUEIDENTIFIER NOT NULL,
    template_name  NVARCHAR(100)    NOT NULL,
    channel        NVARCHAR(10)     NOT NULL CHECK (channel IN ('email', 'sms')),
    subject        NVARCHAR(300)    NULL,
    body           NVARCHAR(MAX)    NOT NULL,
    is_active      BIT              NOT NULL,
    action         NVARCHAR(30)     NOT NULL CHECK (action IN ('update', 'deactivate', 'rollback_before', 'rollback_applied')),
    reason         NVARCHAR(500)    NULL,
    changed_by     NVARCHAR(255)    NULL,
    created_at     DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT PK_notification_template_version PRIMARY KEY (version_id),
    CONSTRAINT FK_notification_template_version_template FOREIGN KEY (template_id)
        REFERENCES dbo.notification_template (template_id)
);

-- ---------------------------------------------------------------------------
-- 9. NotificationLog  (record of every notification sent or attempted)
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.notification_log', N'U') IS NULL
CREATE TABLE dbo.notification_log (
    log_id       UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    event_id     UNIQUEIDENTIFIER NULL,
    member_id    UNIQUEIDENTIFIER NULL,
    template_id  UNIQUEIDENTIFIER NULL,
    channel      NVARCHAR(10)     NOT NULL CHECK (channel IN ('email', 'sms')),
    recipient    NVARCHAR(255)    NOT NULL,  -- email address or phone number
    status       NVARCHAR(20)     NOT NULL
        CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'stubbed')),
    operation_type NVARCHAR(50)   NULL,
    operation_reason NVARCHAR(500) NULL,
    provider_id  NVARCHAR(255)    NULL,  -- message-ID returned by Azure Communication Services
    error_detail NVARCHAR(MAX)    NULL,
    sent_at      DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT PK_notification_log           PRIMARY KEY (log_id),
    CONSTRAINT FK_notification_log_event     FOREIGN KEY (event_id)
        REFERENCES dbo.event  (event_id),
    CONSTRAINT FK_notification_log_member    FOREIGN KEY (member_id)
        REFERENCES dbo.member (member_id),
    CONSTRAINT FK_notification_log_template  FOREIGN KEY (template_id)
        REFERENCES dbo.notification_template (template_id)
);

-- Ensure notification_log status constraint includes 'skipped' for SMS opt-out handling.
IF OBJECT_ID(N'dbo.notification_log', N'U') IS NOT NULL
BEGIN
    IF COL_LENGTH('dbo.notification_log', 'operation_type') IS NULL
        ALTER TABLE dbo.notification_log ADD operation_type NVARCHAR(50) NULL;

    IF COL_LENGTH('dbo.notification_log', 'operation_reason') IS NULL
        ALTER TABLE dbo.notification_log ADD operation_reason NVARCHAR(500) NULL;

    DECLARE @notificationLogStatusColumnId INT = COLUMNPROPERTY(OBJECT_ID(N'dbo.notification_log'), 'status', 'ColumnId');
    DECLARE @dropStatusConstraintSql NVARCHAR(MAX);

    SELECT @dropStatusConstraintSql = STRING_AGG(
        N'ALTER TABLE dbo.notification_log DROP CONSTRAINT [' + cc.name + N'];',
        N' '
    )
    FROM sys.check_constraints cc
    WHERE cc.parent_object_id = OBJECT_ID(N'dbo.notification_log')
      AND cc.parent_column_id = @notificationLogStatusColumnId;

    IF @dropStatusConstraintSql IS NOT NULL AND LEN(@dropStatusConstraintSql) > 0
        EXEC sp_executesql @dropStatusConstraintSql;

    IF NOT EXISTS (
        SELECT 1
        FROM sys.check_constraints
        WHERE name = N'CK_notification_log_status'
          AND parent_object_id = OBJECT_ID(N'dbo.notification_log')
    )
    BEGIN
        ALTER TABLE dbo.notification_log
        ADD CONSTRAINT CK_notification_log_status
            CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'stubbed', 'skipped'));
    END
END

-- ---------------------------------------------------------------------------
-- 10. SMSConsentLog  (audit trail of opt-in / opt-out actions)
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.sms_consent_log', N'U') IS NULL
CREATE TABLE dbo.sms_consent_log (
    consent_log_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    member_id      UNIQUEIDENTIFIER NOT NULL,
    action         NVARCHAR(10)     NOT NULL CHECK (action IN ('opt_in', 'opt_out')),
    source         NVARCHAR(20)     NOT NULL CHECK (source IN ('import', 'manual', 'reply')),
    recorded_at    DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    notes          NVARCHAR(500)    NULL,
    CONSTRAINT PK_sms_consent_log         PRIMARY KEY (consent_log_id),
    CONSTRAINT FK_sms_consent_log_member  FOREIGN KEY (member_id)
        REFERENCES dbo.member (member_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 11. ImportLog  (tracks each CSV import run)
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.inbound_sms_log', N'U') IS NULL
CREATE TABLE dbo.inbound_sms_log (
    inbound_log_id     UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    source             NVARCHAR(20)     NOT NULL CHECK (source IN ('direct', 'event_grid', 'tokenized')),
    from_phone         NVARCHAR(30)     NOT NULL,
    normalized_phone   NVARCHAR(30)     NULL,
    member_id          UNIQUEIDENTIFIER NULL,
    event_id           UNIQUEIDENTIFIER NULL,
    inbound_message    NVARCHAR(500)    NOT NULL,
    parsed_response    NVARCHAR(20)     NULL,
    processing_status  NVARCHAR(50)     NOT NULL,
    response_message   NVARCHAR(500)    NULL,
    error_detail       NVARCHAR(1000)   NULL,
    received_at        DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT PK_inbound_sms_log PRIMARY KEY (inbound_log_id),
    CONSTRAINT FK_inbound_sms_log_member FOREIGN KEY (member_id)
        REFERENCES dbo.member (member_id),
    CONSTRAINT FK_inbound_sms_log_event FOREIGN KEY (event_id)
        REFERENCES dbo.event (event_id)
);

IF OBJECT_ID(N'dbo.inbound_sms_log', N'U') IS NOT NULL
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.inbound_sms_log')
          AND name = N'IX_inbound_sms_log_received_at'
    )
        CREATE INDEX IX_inbound_sms_log_received_at ON dbo.inbound_sms_log (received_at DESC);
END

IF OBJECT_ID(N'dbo.email_preference_log', N'U') IS NULL
CREATE TABLE dbo.email_preference_log (
    email_preference_log_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    member_id               UNIQUEIDENTIFIER NULL,
    recipient_email         NVARCHAR(255)    NULL,
    action                  NVARCHAR(20)     NOT NULL CHECK (action IN ('opt_in', 'opt_out')),
    source                  NVARCHAR(20)     NOT NULL CHECK (source IN ('link', 'manual', 'api', 'system')),
    outcome                 NVARCHAR(30)     NOT NULL CHECK (outcome IN ('unsubscribed', 'already_unsubscribed', 'member_not_found', 'invalid_token')),
    token_expires_at        DATETIME         NULL,
    notes                   NVARCHAR(500)    NULL,
    recorded_at             DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT PK_email_preference_log PRIMARY KEY (email_preference_log_id),
    CONSTRAINT FK_email_preference_log_member FOREIGN KEY (member_id)
        REFERENCES dbo.member (member_id)
);

IF OBJECT_ID(N'dbo.email_preference_log', N'U') IS NOT NULL
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.email_preference_log')
          AND name = N'IX_email_preference_log_recorded_at'
    )
        CREATE INDEX IX_email_preference_log_recorded_at ON dbo.email_preference_log (recorded_at DESC);

    IF NOT EXISTS (
        SELECT 1
        FROM sys.indexes
        WHERE object_id = OBJECT_ID(N'dbo.email_preference_log')
          AND name = N'IX_email_preference_log_member_recorded_at'
    )
        CREATE INDEX IX_email_preference_log_member_recorded_at ON dbo.email_preference_log (member_id, recorded_at DESC);
END

-- ---------------------------------------------------------------------------
-- 12. ImportLog  (tracks each CSV import run)
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.import_log', N'U') IS NULL
CREATE TABLE dbo.import_log (
    import_id        UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    imported_by      UNIQUEIDENTIFIER NULL,  -- FK to dbo.[user]
    file_name        NVARCHAR(255)    NULL,
    rows_processed   INT              NOT NULL DEFAULT 0,
    rows_inserted    INT              NOT NULL DEFAULT 0,
    rows_updated     INT              NOT NULL DEFAULT 0,
    rows_skipped     INT              NOT NULL DEFAULT 0,
    rows_errored     INT              NOT NULL DEFAULT 0,
    status           NVARCHAR(20)     NOT NULL
        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    error_detail     NVARCHAR(MAX)    NULL,
    started_at       DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    completed_at     DATETIME         NULL,
    CONSTRAINT PK_import_log PRIMARY KEY (import_id)
);

-- ---------------------------------------------------------------------------
-- 13. [user]  (application admin / staff accounts; distinct from member)
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.[user]', N'U') IS NULL
CREATE TABLE dbo.[user] (
    user_id        UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    azure_oid      NVARCHAR(255)    NULL,   -- Azure AD B2C object ID
    email          NVARCHAR(255)    NOT NULL,
    display_name   NVARCHAR(200)    NULL,
    role           NVARCHAR(20)     NOT NULL DEFAULT 'admin'
        CHECK (role IN ('admin', 'superadmin')),
    is_active      BIT              NOT NULL DEFAULT 1,
    last_login     DATETIME         NULL,
    created_at     DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    updated_at     DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT PK_user        PRIMARY KEY (user_id),
    CONSTRAINT UQ_user_email  UNIQUE      (email)
);

-- Now that dbo.[user] exists, add the FK from dbo.event.created_by
IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_event_created_by'
)
ALTER TABLE dbo.event
    ADD CONSTRAINT FK_event_created_by
        FOREIGN KEY (created_by) REFERENCES dbo.[user] (user_id);

-- And from dbo.import_log.imported_by
IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys WHERE name = 'FK_import_log_user'
)
ALTER TABLE dbo.import_log
    ADD CONSTRAINT FK_import_log_user
        FOREIGN KEY (imported_by) REFERENCES dbo.[user] (user_id);

-- ---------------------------------------------------------------------------
-- 14. TakeAVetPosting  (Take-A-Vet program listings)
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.take_a_vet_posting', N'U') IS NULL
CREATE TABLE dbo.take_a_vet_posting (
    posting_id    UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    event_id      UNIQUEIDENTIFIER NULL,
    title         NVARCHAR(200)    NOT NULL,
    description   NVARCHAR(MAX)    NULL,
    location      NVARCHAR(300)    NULL,
    activity_date DATETIME         NOT NULL,
    spots_total   INT              NOT NULL DEFAULT 1,
    spots_filled  INT              NOT NULL DEFAULT 0,
    status        NVARCHAR(20)     NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'full', 'cancelled', 'completed')),
    created_by    UNIQUEIDENTIFIER NULL,
    created_at    DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    updated_at    DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    CONSTRAINT PK_take_a_vet_posting            PRIMARY KEY (posting_id),
    CONSTRAINT CK_tav_spots                     CHECK (spots_filled <= spots_total),
    CONSTRAINT FK_take_a_vet_posting_event      FOREIGN KEY (event_id)
        REFERENCES dbo.event  (event_id),
    CONSTRAINT FK_take_a_vet_posting_user       FOREIGN KEY (created_by)
        REFERENCES dbo.[user] (user_id)
);

-- ---------------------------------------------------------------------------
-- 14. WaitlistPromotionOffer (tracks timed offers when waitlist slots open)
-- ---------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.waitlist_promotion_offer', N'U') IS NULL
CREATE TABLE dbo.waitlist_promotion_offer (
    offer_id      UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
    event_id      UNIQUEIDENTIFIER NOT NULL,
    member_id     UNIQUEIDENTIFIER NOT NULL,
    role          NVARCHAR(20)     NOT NULL DEFAULT 'PARTICIPANT'
        CHECK (role IN ('MENTOR', 'PARTICIPANT')),
    status        NVARCHAR(20)     NOT NULL
        CHECK (status IN ('offered', 'accepted', 'expired', 'declined')),
    offered_at    DATETIME         NOT NULL DEFAULT GETUTCDATE(),
    expires_at    DATETIME         NOT NULL,
    resolved_at   DATETIME         NULL,
    CONSTRAINT PK_waitlist_promotion_offer PRIMARY KEY (offer_id),
    CONSTRAINT FK_waitlist_offer_event FOREIGN KEY (event_id)
        REFERENCES dbo.event (event_id) ON DELETE CASCADE,
    CONSTRAINT FK_waitlist_offer_member FOREIGN KEY (member_id)
        REFERENCES dbo.member (member_id) ON DELETE CASCADE
);

IF OBJECT_ID(N'dbo.waitlist_promotion_offer', N'U') IS NOT NULL
BEGIN
    IF COL_LENGTH('dbo.waitlist_promotion_offer', 'role') IS NULL
        ALTER TABLE dbo.waitlist_promotion_offer ADD role NVARCHAR(20) NOT NULL DEFAULT 'PARTICIPANT';

    IF NOT EXISTS (
        SELECT 1
        FROM sys.check_constraints
        WHERE name = N'CK_waitlist_promotion_offer_role'
          AND parent_object_id = OBJECT_ID(N'dbo.waitlist_promotion_offer')
    )
        EXEC sp_executesql N'
            ALTER TABLE dbo.waitlist_promotion_offer
            ADD CONSTRAINT CK_waitlist_promotion_offer_role
                CHECK (role IN (''MENTOR'', ''PARTICIPANT''));
        ';
END

-- ===========================================================================
-- Indexes
-- ===========================================================================

-- member
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_member_email' AND object_id = OBJECT_ID('dbo.member'))
    CREATE INDEX idx_member_email     ON dbo.member (email);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_member_composite' AND object_id = OBJECT_ID('dbo.member'))
    CREATE INDEX idx_member_composite ON dbo.member (email, first_name, last_name);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_member_active' AND object_id = OBJECT_ID('dbo.member'))
    CREATE INDEX idx_member_active    ON dbo.member (is_active);

-- event
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_event_date' AND object_id = OBJECT_ID('dbo.event'))
    CREATE INDEX idx_event_date       ON dbo.event (event_date);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_event_status' AND object_id = OBJECT_ID('dbo.event'))
    CREATE INDEX idx_event_status     ON dbo.event (status);

-- event_response
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_event_response_event' AND object_id = OBJECT_ID('dbo.event_response'))
    CREATE INDEX idx_event_response_event         ON dbo.event_response (event_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_event_response_member' AND object_id = OBJECT_ID('dbo.event_response'))
    CREATE INDEX idx_event_response_member        ON dbo.event_response (member_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_event_response_event_resp' AND object_id = OBJECT_ID('dbo.event_response'))
    CREATE INDEX idx_event_response_event_resp    ON dbo.event_response (event_id, response);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_event_response_reminder_claim' AND object_id = OBJECT_ID('dbo.event_response'))
    CREATE INDEX idx_event_response_reminder_claim ON dbo.event_response (reminder_claim_token, reminder_claimed_at);

-- waitlist_promotion_offer
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_waitlist_offer_event_status' AND object_id = OBJECT_ID('dbo.waitlist_promotion_offer'))
    CREATE INDEX idx_waitlist_offer_event_status ON dbo.waitlist_promotion_offer (event_id, status, expires_at);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_waitlist_offer_event_role_status' AND object_id = OBJECT_ID('dbo.waitlist_promotion_offer'))
BEGIN
    IF COL_LENGTH('dbo.waitlist_promotion_offer', 'role') IS NOT NULL
        EXEC sp_executesql N'CREATE INDEX idx_waitlist_offer_event_role_status ON dbo.waitlist_promotion_offer (event_id, role, status, expires_at);';
END

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_waitlist_offer_member_event' AND object_id = OBJECT_ID('dbo.waitlist_promotion_offer'))
    CREATE INDEX idx_waitlist_offer_member_event ON dbo.waitlist_promotion_offer (member_id, event_id, offered_at DESC);

-- notification_log
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_notification_log_event' AND object_id = OBJECT_ID('dbo.notification_log'))
    CREATE INDEX idx_notification_log_event  ON dbo.notification_log (event_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_notification_log_member' AND object_id = OBJECT_ID('dbo.notification_log'))
    CREATE INDEX idx_notification_log_member ON dbo.notification_log (member_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_notification_log_status' AND object_id = OBJECT_ID('dbo.notification_log'))
    CREATE INDEX idx_notification_log_status ON dbo.notification_log (status);

-- member_group
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_member_group_member_id' AND object_id = OBJECT_ID('dbo.member_group'))
    CREATE INDEX idx_member_group_member_id ON dbo.member_group (member_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_member_group_group_id' AND object_id = OBJECT_ID('dbo.member_group'))
    CREATE INDEX idx_member_group_group_id  ON dbo.member_group (group_id);

-- ===========================================================================
-- Seed: System groups
-- ALL members are added here automatically; other groups are managed manually.
-- ===========================================================================

IF NOT EXISTS (SELECT 1 FROM dbo.[group] WHERE group_name = 'ALL')
    INSERT INTO dbo.[group] (group_id, group_name, description, is_system)
    VALUES (NEWID(), 'ALL', 'All active members', 1);

IF NOT EXISTS (SELECT 1 FROM dbo.[group] WHERE group_name = 'ADMIN')
    INSERT INTO dbo.[group] (group_id, group_name, description, is_system)
    VALUES (NEWID(), 'ADMIN', 'Chapter administrators', 1);

IF NOT EXISTS (SELECT 1 FROM dbo.[group] WHERE group_name = 'MENTORS')
    INSERT INTO dbo.[group] (group_id, group_name, description, is_system)
    VALUES (NEWID(), 'MENTORS', 'Mentors / guides', 1);

IF NOT EXISTS (SELECT 1 FROM dbo.[group] WHERE group_name = 'PARTICIPANTS')
    INSERT INTO dbo.[group] (group_id, group_name, description, is_system)
    VALUES (NEWID(), 'PARTICIPANTS', 'Program participants (veterans)', 1);

-- ============================================================
-- TAVF (Take a Vet Fishing) Tables
-- ============================================================

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tavf_posting')
BEGIN
    CREATE TABLE dbo.tavf_posting (
        posting_id      UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        guide_member_id UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.member(member_id),
        event_date      DATE NOT NULL,
        location        NVARCHAR(500) NOT NULL,
        capacity        INT NOT NULL DEFAULT 1,
        species         NVARCHAR(200),
        description     NVARCHAR(2000),
        status          NVARCHAR(20) NOT NULL DEFAULT 'open'
                            CONSTRAINT chk_tavf_posting_status CHECK (status IN ('open', 'filled', 'cancelled')),
        created_at      DATETIME NOT NULL DEFAULT GETDATE(),
        updated_at      DATETIME NOT NULL DEFAULT GETDATE()
    );
    CREATE INDEX idx_tavf_posting_guide  ON dbo.tavf_posting(guide_member_id);
    CREATE INDEX idx_tavf_posting_date   ON dbo.tavf_posting(event_date);
    CREATE INDEX idx_tavf_posting_status ON dbo.tavf_posting(status);
END;

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tavf_application')
BEGIN
    CREATE TABLE dbo.tavf_application (
        application_id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        posting_id     UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.tavf_posting(posting_id),
        vet_member_id  UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.member(member_id),
        notes          NVARCHAR(1000),
        status         NVARCHAR(20) NOT NULL DEFAULT 'pending'
                           CONSTRAINT chk_tavf_application_status CHECK (status IN ('pending', 'matched', 'waitlisted', 'withdrawn')),
        applied_at     DATETIME NOT NULL DEFAULT GETDATE(),
        updated_at     DATETIME NOT NULL DEFAULT GETDATE(),
        CONSTRAINT uq_tavf_application UNIQUE (posting_id, vet_member_id)
    );
    CREATE INDEX idx_tavf_application_posting ON dbo.tavf_application(posting_id);
    CREATE INDEX idx_tavf_application_vet     ON dbo.tavf_application(vet_member_id);
END;

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'tavf_match')
BEGIN
    CREATE TABLE dbo.tavf_match (
        match_id       UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
        posting_id     UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.tavf_posting(posting_id),
        application_id UNIQUEIDENTIFIER NOT NULL REFERENCES dbo.tavf_application(application_id),
        matched_by     UNIQUEIDENTIFIER REFERENCES dbo.member(member_id),
        matched_at     DATETIME NOT NULL DEFAULT GETDATE(),
        status         NVARCHAR(20) NOT NULL DEFAULT 'confirmed'
                           CONSTRAINT chk_tavf_match_status CHECK (status IN ('confirmed', 'cancelled')),
        notes          NVARCHAR(1000),
        CONSTRAINT uq_tavf_match UNIQUE (posting_id, application_id)
    );
    CREATE INDEX idx_tavf_match_posting     ON dbo.tavf_match(posting_id);
    CREATE INDEX idx_tavf_match_application ON dbo.tavf_match(application_id);
END;
-- ---------------------------------------------------------------------------
-- Wave 2 Migrations
-- ---------------------------------------------------------------------------

-- Add 'skipped' to notification_log.status CHECK constraint
-- Drop old constraint and recreate with 'skipped' included
IF EXISTS (
    SELECT 1 FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID('dbo.notification_log')
      AND name LIKE '%status%'
)
BEGIN
    DECLARE @constraintName NVARCHAR(200);
    SELECT @constraintName = name
    FROM sys.check_constraints
    WHERE parent_object_id = OBJECT_ID('dbo.notification_log')
      AND name LIKE '%status%';
    EXEC('ALTER TABLE dbo.notification_log DROP CONSTRAINT ' + @constraintName);
    ALTER TABLE dbo.notification_log
        ADD CONSTRAINT CHK_notification_log_status
        CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'stubbed', 'skipped'));
END;

-- Add attended and attendance_notes columns to event_assignment if not present
IF COL_LENGTH('dbo.event_assignment', 'attended') IS NULL
    ALTER TABLE dbo.event_assignment ADD attended BIT NOT NULL DEFAULT 0;

IF COL_LENGTH('dbo.event_assignment', 'attendance_notes') IS NULL
    ALTER TABLE dbo.event_assignment ADD attendance_notes NVARCHAR(500) NULL;
