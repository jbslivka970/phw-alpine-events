-- Azure SQL Database Schema for PHW Alpine Events
-- Based on PRD Section 5.1 Data Model
--
-- Implementation notes:
--   - email is NOT unique on member to support shared-email households (PRD requirement)
--   - system groups (ALL, ADMIN, MENTORS, PARTICIPANTS) are seeded via INSERT after table creation
--   - all primary keys use UNIQUEIDENTIFIER / NEWID() for Azure portability
--   - DATETIME columns use GETDATE() as default; application is responsible for updating updated_at
--   - deploy-schema.ts executes this file as a single batch; IF NOT EXISTS guards make it idempotent

-- ============================================================
-- Member
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'member')
BEGIN
    CREATE TABLE member (
        member_id        UNIQUEIDENTIFIER  PRIMARY KEY DEFAULT NEWID(),
        first_name       NVARCHAR(100)     NOT NULL,
        last_name        NVARCHAR(100)     NOT NULL,
        -- email intentionally not unique: shared-email households are allowed (PRD §5.1)
        email            NVARCHAR(255)     NOT NULL,
        mobile_phone     NVARCHAR(20),
        sms_opt_in       BIT               NOT NULL DEFAULT 0,
        sms_opt_in_date  DATETIME,
        sms_opt_out_date DATETIME,
        email_opt_out    BIT               NOT NULL DEFAULT 0,
        salutation       NVARCHAR(50),
        title            NVARCHAR(100),
        account_name     NVARCHAR(200),
        source           NVARCHAR(10)      NOT NULL CHECK (source IN ('import', 'manual')),
        last_import_hash NVARCHAR(64),
        last_manual_edit DATETIME,
        is_active        BIT               NOT NULL DEFAULT 1,
        created_at       DATETIME          NOT NULL DEFAULT GETDATE(),
        updated_at       DATETIME          NOT NULL DEFAULT GETDATE()
    );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_member_email')
    CREATE INDEX idx_member_email ON member(email);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_member_composite')
    CREATE INDEX idx_member_composite ON member(email, first_name, last_name);

-- ============================================================
-- [group] – square-bracketed because GROUP is a reserved word
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'group')
BEGIN
    CREATE TABLE [group] (
        group_id    UNIQUEIDENTIFIER  PRIMARY KEY DEFAULT NEWID(),
        name        NVARCHAR(100)     NOT NULL,
        description NVARCHAR(500),
        is_system   BIT               NOT NULL DEFAULT 0,  -- 1 = built-in group; cannot be deleted
        created_at  DATETIME          NOT NULL DEFAULT GETDATE(),
        updated_at  DATETIME          NOT NULL DEFAULT GETDATE(),
        CONSTRAINT uq_group_name UNIQUE (name)
    );
END;

-- ============================================================
-- MemberGroup (junction)
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'member_group')
BEGIN
    CREATE TABLE member_group (
        member_group_id UNIQUEIDENTIFIER  PRIMARY KEY DEFAULT NEWID(),
        member_id       UNIQUEIDENTIFIER  NOT NULL REFERENCES member(member_id) ON DELETE CASCADE,
        group_id        UNIQUEIDENTIFIER  NOT NULL REFERENCES [group](group_id) ON DELETE CASCADE,
        added_at        DATETIME          NOT NULL DEFAULT GETDATE(),
        CONSTRAINT uq_member_group UNIQUE (member_id, group_id)
    );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_member_group_member')
    CREATE INDEX idx_member_group_member ON member_group(member_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_member_group_group')
    CREATE INDEX idx_member_group_group ON member_group(group_id);

-- ============================================================
-- Event
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'event')
BEGIN
    CREATE TABLE [event] (
        event_id          UNIQUEIDENTIFIER  PRIMARY KEY DEFAULT NEWID(),
        title             NVARCHAR(200)     NOT NULL,
        description       NVARCHAR(MAX),
        location          NVARCHAR(300),
        event_date        DATETIME          NOT NULL,
        end_date          DATETIME,
        capacity          INT,
        status            NVARCHAR(20)      NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft', 'published', 'cancelled', 'completed')),
        created_by        UNIQUEIDENTIFIER, -- FK to [user] added after that table is created
        created_at        DATETIME          NOT NULL DEFAULT GETDATE(),
        updated_at        DATETIME          NOT NULL DEFAULT GETDATE()
    );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_event_date')
    CREATE INDEX idx_event_date ON [event](event_date);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_event_status')
    CREATE INDEX idx_event_status ON [event](status);

-- ============================================================
-- EventNotificationTarget – which groups receive notifications for an event
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'event_notification_target')
BEGIN
    CREATE TABLE event_notification_target (
        target_id  UNIQUEIDENTIFIER  PRIMARY KEY DEFAULT NEWID(),
        event_id   UNIQUEIDENTIFIER  NOT NULL REFERENCES [event](event_id) ON DELETE CASCADE,
        group_id   UNIQUEIDENTIFIER  NOT NULL REFERENCES [group](group_id),
        added_at   DATETIME          NOT NULL DEFAULT GETDATE(),
        CONSTRAINT uq_event_notification_target UNIQUE (event_id, group_id)
    );
END;

-- ============================================================
-- EventResponse – member RSVP / attendance
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'event_response')
BEGIN
    CREATE TABLE event_response (
        response_id    UNIQUEIDENTIFIER  PRIMARY KEY DEFAULT NEWID(),
        event_id       UNIQUEIDENTIFIER  NOT NULL REFERENCES [event](event_id) ON DELETE CASCADE,
        member_id      UNIQUEIDENTIFIER  NOT NULL REFERENCES member(member_id),
        response       NVARCHAR(20)      NOT NULL
                           CHECK (response IN ('attending', 'declined', 'waitlisted', 'no_response')),
        responded_at   DATETIME          NOT NULL DEFAULT GETDATE(),
        updated_at     DATETIME          NOT NULL DEFAULT GETDATE(),
        CONSTRAINT uq_event_response UNIQUE (event_id, member_id)
    );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_event_response_event')
    CREATE INDEX idx_event_response_event ON event_response(event_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_event_response_member')
    CREATE INDEX idx_event_response_member ON event_response(member_id);

-- ============================================================
-- EventAssignment – staff / volunteer assignments for an event
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'event_assignment')
BEGIN
    CREATE TABLE event_assignment (
        assignment_id UNIQUEIDENTIFIER  PRIMARY KEY DEFAULT NEWID(),
        event_id      UNIQUEIDENTIFIER  NOT NULL REFERENCES [event](event_id) ON DELETE CASCADE,
        member_id     UNIQUEIDENTIFIER  NOT NULL REFERENCES member(member_id),
        role          NVARCHAR(100),
        assigned_at   DATETIME          NOT NULL DEFAULT GETDATE(),
        CONSTRAINT uq_event_assignment UNIQUE (event_id, member_id, role)
    );
END;

-- ============================================================
-- NotificationTemplate
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'notification_template')
BEGIN
    CREATE TABLE notification_template (
        template_id  UNIQUEIDENTIFIER  PRIMARY KEY DEFAULT NEWID(),
        name         NVARCHAR(200)     NOT NULL,
        channel      NVARCHAR(10)      NOT NULL CHECK (channel IN ('email', 'sms')),
        subject      NVARCHAR(500),        -- email subject (null for SMS)
        body         NVARCHAR(MAX)     NOT NULL,
        is_active    BIT               NOT NULL DEFAULT 1,
        created_at   DATETIME          NOT NULL DEFAULT GETDATE(),
        updated_at   DATETIME          NOT NULL DEFAULT GETDATE(),
        CONSTRAINT uq_notification_template_name UNIQUE (name)
    );
END;

-- ============================================================
-- NotificationLog – audit trail of every notification sent
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'notification_log')
BEGIN
    CREATE TABLE notification_log (
        log_id       UNIQUEIDENTIFIER  PRIMARY KEY DEFAULT NEWID(),
        event_id     UNIQUEIDENTIFIER  REFERENCES [event](event_id),  -- nullable; system notifications have no event
        member_id    UNIQUEIDENTIFIER  REFERENCES member(member_id),
        template_id  UNIQUEIDENTIFIER  REFERENCES notification_template(template_id),
        channel      NVARCHAR(10)      NOT NULL CHECK (channel IN ('email', 'sms')),
        recipient    NVARCHAR(255)     NOT NULL,  -- email address or phone number
        status       NVARCHAR(20)      NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'sent', 'failed', 'bounced')),
        sent_at      DATETIME,
        error_detail NVARCHAR(MAX),
        created_at   DATETIME          NOT NULL DEFAULT GETDATE()
    );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_notification_log_event')
    CREATE INDEX idx_notification_log_event ON notification_log(event_id);

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_notification_log_member')
    CREATE INDEX idx_notification_log_member ON notification_log(member_id);

-- ============================================================
-- SMSConsentLog – audit trail for opt-in / opt-out events
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'sms_consent_log')
BEGIN
    CREATE TABLE sms_consent_log (
        consent_id  UNIQUEIDENTIFIER  PRIMARY KEY DEFAULT NEWID(),
        member_id   UNIQUEIDENTIFIER  NOT NULL REFERENCES member(member_id),
        action      NVARCHAR(10)      NOT NULL CHECK (action IN ('opt_in', 'opt_out')),
        source      NVARCHAR(50),   -- e.g. 'web_form', 'sms_keyword', 'admin'
        ip_address  NVARCHAR(45),
        recorded_at DATETIME          NOT NULL DEFAULT GETDATE()
    );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_sms_consent_log_member')
    CREATE INDEX idx_sms_consent_log_member ON sms_consent_log(member_id);

-- ============================================================
-- ImportLog – history of CSV import jobs
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'import_log')
BEGIN
    CREATE TABLE import_log (
        import_id        UNIQUEIDENTIFIER  PRIMARY KEY DEFAULT NEWID(),
        filename         NVARCHAR(500)     NOT NULL,
        imported_by      UNIQUEIDENTIFIER, -- FK to [user]; set after user table exists
        rows_total       INT               NOT NULL DEFAULT 0,
        rows_inserted    INT               NOT NULL DEFAULT 0,
        rows_updated     INT               NOT NULL DEFAULT 0,
        rows_skipped     INT               NOT NULL DEFAULT 0,
        rows_errored     INT               NOT NULL DEFAULT 0,
        status           NVARCHAR(20)      NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
        error_detail     NVARCHAR(MAX),
        started_at       DATETIME          NOT NULL DEFAULT GETDATE(),
        completed_at     DATETIME
    );
END;

-- ============================================================
-- [user] – application login accounts (distinct from members)
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'user')
BEGIN
    CREATE TABLE [user] (
        user_id        UNIQUEIDENTIFIER  PRIMARY KEY DEFAULT NEWID(),
        azure_oid      NVARCHAR(100)     NOT NULL, -- Azure AD B2C object ID
        email          NVARCHAR(255)     NOT NULL,
        display_name   NVARCHAR(200),
        role           NVARCHAR(30)      NOT NULL DEFAULT 'USER'
                           CHECK (role IN ('ADMIN', 'EVENT_CREATOR', 'USER')),
        is_active      BIT               NOT NULL DEFAULT 1,
        last_login     DATETIME,
        created_at     DATETIME          NOT NULL DEFAULT GETDATE(),
        updated_at     DATETIME          NOT NULL DEFAULT GETDATE(),
        CONSTRAINT uq_user_azure_oid UNIQUE (azure_oid),
        CONSTRAINT uq_user_email     UNIQUE (email)
    );
END;

-- Add FK from event.created_by -> [user] now that [user] exists
IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'fk_event_created_by' AND parent_object_id = OBJECT_ID('[event]')
)
BEGIN
    ALTER TABLE [event]
        ADD CONSTRAINT fk_event_created_by
        FOREIGN KEY (created_by) REFERENCES [user](user_id);
END;

-- Add FK from import_log.imported_by -> [user]
IF NOT EXISTS (
    SELECT 1 FROM sys.foreign_keys
    WHERE name = 'fk_import_log_user' AND parent_object_id = OBJECT_ID('import_log')
)
BEGIN
    ALTER TABLE import_log
        ADD CONSTRAINT fk_import_log_user
        FOREIGN KEY (imported_by) REFERENCES [user](user_id);
END;

-- ============================================================
-- TakeAVetPosting – volunteer opportunity posts
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_NAME = 'take_a_vet_posting')
BEGIN
    CREATE TABLE take_a_vet_posting (
        posting_id   UNIQUEIDENTIFIER  PRIMARY KEY DEFAULT NEWID(),
        event_id     UNIQUEIDENTIFIER  REFERENCES [event](event_id) ON DELETE SET NULL,
        title        NVARCHAR(200)     NOT NULL,
        description  NVARCHAR(MAX),
        slots_total  INT               NOT NULL DEFAULT 1,
        slots_filled INT               NOT NULL DEFAULT 0,
        status       NVARCHAR(20)      NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open', 'filled', 'cancelled')),
        posted_by    UNIQUEIDENTIFIER  REFERENCES [user](user_id),
        created_at   DATETIME          NOT NULL DEFAULT GETDATE(),
        updated_at   DATETIME          NOT NULL DEFAULT GETDATE()
    );
END;

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_take_a_vet_event')
    CREATE INDEX idx_take_a_vet_event ON take_a_vet_posting(event_id);

-- ============================================================
-- Seed system groups (idempotent)
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM [group] WHERE name = 'ALL')
    INSERT INTO [group] (name, description, is_system) VALUES ('ALL', 'All active members', 1);

IF NOT EXISTS (SELECT 1 FROM [group] WHERE name = 'ADMIN')
    INSERT INTO [group] (name, description, is_system) VALUES ('ADMIN', 'Administrators', 1);

IF NOT EXISTS (SELECT 1 FROM [group] WHERE name = 'MENTORS')
    INSERT INTO [group] (name, description, is_system) VALUES ('MENTORS', 'Mentors', 1);

IF NOT EXISTS (SELECT 1 FROM [group] WHERE name = 'PARTICIPANTS')
    INSERT INTO [group] (name, description, is_system) VALUES ('PARTICIPANTS', 'Participants / veterans', 1);