-- Azure SQL Database Schema for PHW Alpine Events
-- Based on PRD Section 5.1 Data Model
-- All CREATE statements use IF NOT EXISTS guards so this script is idempotent.
-- Run via:  cd backend && npm run deploy-schema
-- Batch separator: GO

-- ============================================================
-- MEMBER
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[member]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[member] (
        member_id           UNIQUEIDENTIFIER  NOT NULL CONSTRAINT DF_member_id DEFAULT NEWID(),
        first_name          NVARCHAR(100)     NOT NULL,
        last_name           NVARCHAR(100)     NOT NULL,
        email               NVARCHAR(255)     NOT NULL,
        mobile_phone        NVARCHAR(20)      NULL,        -- stored in E.164 format
        sms_opt_in          BIT               NOT NULL CONSTRAINT DF_member_sms_opt_in DEFAULT 0,
        sms_opt_in_date     DATETIME          NULL,
        sms_opt_out_date    DATETIME          NULL,
        email_opt_out       BIT               NOT NULL CONSTRAINT DF_member_email_opt_out DEFAULT 0,
        salutation          NVARCHAR(50)      NULL,
        title               NVARCHAR(100)     NULL,
        account_name        NVARCHAR(200)     NULL,
        source              NVARCHAR(10)      NULL CONSTRAINT CK_member_source CHECK (source IN ('import', 'manual')),
        last_import_hash    NVARCHAR(64)      NULL,
        last_manual_edit    DATETIME          NULL,
        is_active           BIT               NOT NULL CONSTRAINT DF_member_is_active DEFAULT 1,
        created_at          DATETIME          NOT NULL CONSTRAINT DF_member_created_at DEFAULT GETUTCDATE(),
        updated_at          DATETIME          NOT NULL CONSTRAINT DF_member_updated_at DEFAULT GETUTCDATE(),
        CONSTRAINT PK_member PRIMARY KEY (member_id)
    );
END
GO

-- ============================================================
-- GROUP
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[group]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[group] (
        group_id    UNIQUEIDENTIFIER  NOT NULL CONSTRAINT DF_group_id DEFAULT NEWID(),
        name        NVARCHAR(100)     NOT NULL,
        is_system   BIT               NOT NULL CONSTRAINT DF_group_is_system DEFAULT 0,
        created_at  DATETIME          NOT NULL CONSTRAINT DF_group_created_at DEFAULT GETUTCDATE(),
        CONSTRAINT PK_group PRIMARY KEY (group_id),
        CONSTRAINT UQ_group_name UNIQUE (name)
    );
END
GO

-- ============================================================
-- MEMBER_GROUP
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[member_group]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[member_group] (
        member_id   UNIQUEIDENTIFIER  NOT NULL,
        group_id    UNIQUEIDENTIFIER  NOT NULL,
        added_at    DATETIME          NOT NULL CONSTRAINT DF_member_group_added_at DEFAULT GETUTCDATE(),
        CONSTRAINT PK_member_group PRIMARY KEY (member_id, group_id),
        CONSTRAINT FK_member_group_member FOREIGN KEY (member_id) REFERENCES [dbo].[member](member_id) ON DELETE CASCADE,
        CONSTRAINT FK_member_group_group  FOREIGN KEY (group_id)  REFERENCES [dbo].[group](group_id)  ON DELETE CASCADE
    );
END
GO

-- ============================================================
-- USER (application users / admin accounts)
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[app_user]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[app_user] (
        user_id       UNIQUEIDENTIFIER  NOT NULL CONSTRAINT DF_app_user_id DEFAULT NEWID(),
        azure_oid     NVARCHAR(64)      NOT NULL,           -- Azure AD B2C object ID
        email         NVARCHAR(255)     NOT NULL,
        display_name  NVARCHAR(200)     NULL,
        role          NVARCHAR(30)      NOT NULL CONSTRAINT CK_app_user_role CHECK (role IN ('ADMIN', 'EVENT_CREATOR', 'USER')),
        is_active     BIT               NOT NULL CONSTRAINT DF_app_user_is_active DEFAULT 1,
        created_at    DATETIME          NOT NULL CONSTRAINT DF_app_user_created_at DEFAULT GETUTCDATE(),
        updated_at    DATETIME          NOT NULL CONSTRAINT DF_app_user_updated_at DEFAULT GETUTCDATE(),
        CONSTRAINT PK_app_user PRIMARY KEY (user_id),
        CONSTRAINT UQ_app_user_azure_oid UNIQUE (azure_oid),
        CONSTRAINT UQ_app_user_email UNIQUE (email)
    );
END
GO

-- ============================================================
-- NOTIFICATION_TEMPLATE
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[notification_template]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[notification_template] (
        template_id   UNIQUEIDENTIFIER  NOT NULL CONSTRAINT DF_nt_id DEFAULT NEWID(),
        name          NVARCHAR(100)     NOT NULL,
        channel       NVARCHAR(10)      NOT NULL CONSTRAINT CK_nt_channel CHECK (channel IN ('email', 'sms')),
        subject       NVARCHAR(255)     NULL,   -- email only
        body          NVARCHAR(MAX)     NOT NULL,
        is_active     BIT               NOT NULL CONSTRAINT DF_nt_is_active DEFAULT 1,
        created_at    DATETIME          NOT NULL CONSTRAINT DF_nt_created_at DEFAULT GETUTCDATE(),
        updated_at    DATETIME          NOT NULL CONSTRAINT DF_nt_updated_at DEFAULT GETUTCDATE(),
        CONSTRAINT PK_notification_template PRIMARY KEY (template_id),
        CONSTRAINT UQ_nt_name_channel UNIQUE (name, channel)
    );
END
GO

-- ============================================================
-- EVENT
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[event]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[event] (
        event_id            UNIQUEIDENTIFIER  NOT NULL CONSTRAINT DF_event_id DEFAULT NEWID(),
        title               NVARCHAR(200)     NOT NULL,
        description         NVARCHAR(MAX)     NULL,
        location            NVARCHAR(300)     NULL,
        event_date          DATETIME          NOT NULL,
        reminder_datetime   DATETIME          NULL,
        mentor_slots        INT               NOT NULL CONSTRAINT DF_event_mentor_slots DEFAULT 0,
        participant_slots   INT               NOT NULL CONSTRAINT DF_event_participant_slots DEFAULT 0,
        status              NVARCHAR(20)      NOT NULL CONSTRAINT DF_event_status DEFAULT 'DRAFT'
                                              CONSTRAINT CK_event_status CHECK (status IN ('DRAFT','PUBLISHED','COMPLETED','CANCELLED')),
        created_by          UNIQUEIDENTIFIER  NULL,
        created_at          DATETIME          NOT NULL CONSTRAINT DF_event_created_at DEFAULT GETUTCDATE(),
        updated_at          DATETIME          NOT NULL CONSTRAINT DF_event_updated_at DEFAULT GETUTCDATE(),
        CONSTRAINT PK_event PRIMARY KEY (event_id),
        CONSTRAINT FK_event_created_by FOREIGN KEY (created_by) REFERENCES [dbo].[app_user](user_id)
    );
END
GO

-- ============================================================
-- EVENT_NOTIFICATION_TARGET
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[event_notification_target]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[event_notification_target] (
        target_id   UNIQUEIDENTIFIER  NOT NULL CONSTRAINT DF_ent_id DEFAULT NEWID(),
        event_id    UNIQUEIDENTIFIER  NOT NULL,
        group_id    UNIQUEIDENTIFIER  NULL,
        member_id   UNIQUEIDENTIFIER  NULL,
        created_at  DATETIME          NOT NULL CONSTRAINT DF_ent_created_at DEFAULT GETUTCDATE(),
        CONSTRAINT PK_event_notification_target PRIMARY KEY (target_id),
        CONSTRAINT FK_ent_event  FOREIGN KEY (event_id)  REFERENCES [dbo].[event](event_id)  ON DELETE CASCADE,
        CONSTRAINT FK_ent_group  FOREIGN KEY (group_id)  REFERENCES [dbo].[group](group_id),
        CONSTRAINT FK_ent_member FOREIGN KEY (member_id) REFERENCES [dbo].[member](member_id)
    );
END
GO

-- ============================================================
-- EVENT_RESPONSE (RSVP)
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[event_response]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[event_response] (
        response_id     UNIQUEIDENTIFIER  NOT NULL CONSTRAINT DF_er_id DEFAULT NEWID(),
        event_id        UNIQUEIDENTIFIER  NOT NULL,
        member_id       UNIQUEIDENTIFIER  NOT NULL,
        group_context   UNIQUEIDENTIFIER  NULL,   -- group through which the invite was sent
        response        NVARCHAR(10)      NOT NULL CONSTRAINT CK_er_response CHECK (response IN ('YES','NO','MAYBE','WAITLIST')),
        responded_at    DATETIME          NOT NULL CONSTRAINT DF_er_responded_at DEFAULT GETUTCDATE(),
        updated_at      DATETIME          NOT NULL CONSTRAINT DF_er_updated_at DEFAULT GETUTCDATE(),
        CONSTRAINT PK_event_response PRIMARY KEY (response_id),
        CONSTRAINT UQ_event_response_member UNIQUE (event_id, member_id),
        CONSTRAINT FK_er_event        FOREIGN KEY (event_id)      REFERENCES [dbo].[event](event_id)  ON DELETE CASCADE,
        CONSTRAINT FK_er_member       FOREIGN KEY (member_id)     REFERENCES [dbo].[member](member_id),
        CONSTRAINT FK_er_group_context FOREIGN KEY (group_context) REFERENCES [dbo].[group](group_id)
    );
END
GO

-- ============================================================
-- EVENT_ASSIGNMENT (mentor / volunteer slot fill)
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[event_assignment]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[event_assignment] (
        assignment_id   UNIQUEIDENTIFIER  NOT NULL CONSTRAINT DF_ea_id DEFAULT NEWID(),
        event_id        UNIQUEIDENTIFIER  NOT NULL,
        member_id       UNIQUEIDENTIFIER  NOT NULL,
        role            NVARCHAR(20)      NOT NULL CONSTRAINT CK_ea_role CHECK (role IN ('MENTOR','PARTICIPANT')),
        assigned_at     DATETIME          NOT NULL CONSTRAINT DF_ea_assigned_at DEFAULT GETUTCDATE(),
        CONSTRAINT PK_event_assignment PRIMARY KEY (assignment_id),
        CONSTRAINT UQ_event_assignment UNIQUE (event_id, member_id, role),
        CONSTRAINT FK_ea_event  FOREIGN KEY (event_id)  REFERENCES [dbo].[event](event_id)  ON DELETE CASCADE,
        CONSTRAINT FK_ea_member FOREIGN KEY (member_id) REFERENCES [dbo].[member](member_id)
    );
END
GO

-- ============================================================
-- NOTIFICATION_LOG
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[notification_log]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[notification_log] (
        log_id          UNIQUEIDENTIFIER  NOT NULL CONSTRAINT DF_nl_id DEFAULT NEWID(),
        event_id        UNIQUEIDENTIFIER  NULL,
        member_id       UNIQUEIDENTIFIER  NULL,
        channel         NVARCHAR(10)      NOT NULL CONSTRAINT CK_nl_channel CHECK (channel IN ('email', 'sms')),
        template_id     UNIQUEIDENTIFIER  NULL,
        status          NVARCHAR(20)      NOT NULL CONSTRAINT CK_nl_status CHECK (status IN ('QUEUED','SENT','FAILED','SKIPPED')),
        error_message   NVARCHAR(500)     NULL,
        sent_at         DATETIME          NULL,
        created_at      DATETIME          NOT NULL CONSTRAINT DF_nl_created_at DEFAULT GETUTCDATE(),
        CONSTRAINT PK_notification_log PRIMARY KEY (log_id),
        CONSTRAINT FK_nl_event    FOREIGN KEY (event_id)   REFERENCES [dbo].[event](event_id),
        CONSTRAINT FK_nl_member   FOREIGN KEY (member_id)  REFERENCES [dbo].[member](member_id),
        CONSTRAINT FK_nl_template FOREIGN KEY (template_id) REFERENCES [dbo].[notification_template](template_id)
    );
END
GO

-- ============================================================
-- SMS_CONSENT_LOG
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[sms_consent_log]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[sms_consent_log] (
        consent_id  UNIQUEIDENTIFIER  NOT NULL CONSTRAINT DF_scl_id DEFAULT NEWID(),
        member_id   UNIQUEIDENTIFIER  NOT NULL,
        action      NVARCHAR(10)      NOT NULL CONSTRAINT CK_scl_action CHECK (action IN ('OPT_IN','OPT_OUT')),
        channel     NVARCHAR(10)      NOT NULL CONSTRAINT CK_scl_channel CHECK (channel IN ('sms','email')),
        recorded_by NVARCHAR(100)     NULL,
        recorded_at DATETIME          NOT NULL CONSTRAINT DF_scl_recorded_at DEFAULT GETUTCDATE(),
        CONSTRAINT PK_sms_consent_log PRIMARY KEY (consent_id),
        CONSTRAINT FK_scl_member FOREIGN KEY (member_id) REFERENCES [dbo].[member](member_id) ON DELETE CASCADE
    );
END
GO

-- ============================================================
-- IMPORT_LOG
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[import_log]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[import_log] (
        import_id       UNIQUEIDENTIFIER  NOT NULL CONSTRAINT DF_il_id DEFAULT NEWID(),
        filename        NVARCHAR(300)     NOT NULL,
        imported_by     NVARCHAR(100)     NULL,
        rows_new        INT               NOT NULL CONSTRAINT DF_il_rows_new DEFAULT 0,
        rows_updated    INT               NOT NULL CONSTRAINT DF_il_rows_updated DEFAULT 0,
        rows_skipped    INT               NOT NULL CONSTRAINT DF_il_rows_skipped DEFAULT 0,
        rows_flagged    INT               NOT NULL CONSTRAINT DF_il_rows_flagged DEFAULT 0,
        status          NVARCHAR(20)      NOT NULL CONSTRAINT CK_il_status CHECK (status IN ('PREVIEW','COMMITTED','FAILED')),
        error_message   NVARCHAR(1000)    NULL,
        imported_at     DATETIME          NOT NULL CONSTRAINT DF_il_imported_at DEFAULT GETUTCDATE(),
        CONSTRAINT PK_import_log PRIMARY KEY (import_id)
    );
END
GO

-- ============================================================
-- TAKE_A_VET_POSTING
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.objects WHERE object_id = OBJECT_ID(N'[dbo].[take_a_vet_posting]') AND type = 'U')
BEGIN
    CREATE TABLE [dbo].[take_a_vet_posting] (
        posting_id      UNIQUEIDENTIFIER  NOT NULL CONSTRAINT DF_tavp_id DEFAULT NEWID(),
        title           NVARCHAR(200)     NOT NULL,
        description     NVARCHAR(MAX)     NULL,
        posted_by       UNIQUEIDENTIFIER  NULL,
        status          NVARCHAR(20)      NOT NULL CONSTRAINT DF_tavp_status DEFAULT 'OPEN'
                                          CONSTRAINT CK_tavp_status CHECK (status IN ('OPEN','MATCHED','EXPIRED','CANCELLED')),
        expires_at      DATETIME          NULL,
        created_at      DATETIME          NOT NULL CONSTRAINT DF_tavp_created_at DEFAULT GETUTCDATE(),
        updated_at      DATETIME          NOT NULL CONSTRAINT DF_tavp_updated_at DEFAULT GETUTCDATE(),
        CONSTRAINT PK_take_a_vet_posting PRIMARY KEY (posting_id),
        CONSTRAINT FK_tavp_posted_by FOREIGN KEY (posted_by) REFERENCES [dbo].[app_user](user_id)
    );
END
GO

-- ============================================================
-- INDEXES
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_member_email' AND object_id = OBJECT_ID('dbo.member'))
    CREATE INDEX idx_member_email ON [dbo].[member](email);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_member_composite' AND object_id = OBJECT_ID('dbo.member'))
    CREATE INDEX idx_member_composite ON [dbo].[member](email, first_name, last_name);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_member_phone' AND object_id = OBJECT_ID('dbo.member'))
    CREATE INDEX idx_member_phone ON [dbo].[member](mobile_phone);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_event_status_date' AND object_id = OBJECT_ID('dbo.event'))
    CREATE INDEX idx_event_status_date ON [dbo].[event](status, event_date);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_event_response_event' AND object_id = OBJECT_ID('dbo.event_response'))
    CREATE INDEX idx_event_response_event ON [dbo].[event_response](event_id, response);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_notification_log_event' AND object_id = OBJECT_ID('dbo.notification_log'))
    CREATE INDEX idx_notification_log_event ON [dbo].[notification_log](event_id, channel, status);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'idx_tavp_status' AND object_id = OBJECT_ID('dbo.take_a_vet_posting'))
    CREATE INDEX idx_tavp_status ON [dbo].[take_a_vet_posting](status, expires_at);
GO

-- ============================================================
-- SEED: system groups (ALL, ADMIN, MENTORS, PARTICIPANTS)
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM [dbo].[group] WHERE name = 'ALL')
    INSERT INTO [dbo].[group] (name, is_system) VALUES ('ALL', 1);
GO

IF NOT EXISTS (SELECT 1 FROM [dbo].[group] WHERE name = 'ADMIN')
    INSERT INTO [dbo].[group] (name, is_system) VALUES ('ADMIN', 1);
GO

IF NOT EXISTS (SELECT 1 FROM [dbo].[group] WHERE name = 'MENTORS')
    INSERT INTO [dbo].[group] (name, is_system) VALUES ('MENTORS', 1);
GO

IF NOT EXISTS (SELECT 1 FROM [dbo].[group] WHERE name = 'PARTICIPANTS')
    INSERT INTO [dbo].[group] (name, is_system) VALUES ('PARTICIPANTS', 1);
GO

-- ============================================================
-- SEED: default notification templates
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM [dbo].[notification_template] WHERE name = 'event_invite' AND channel = 'email')
    INSERT INTO [dbo].[notification_template] (name, channel, subject, body)
    VALUES (
        'event_invite', 'email',
        'You''re invited: {{event_title}}',
        'Hi {{first_name}},\n\nWe''d love to have you join us for {{event_title}} on {{event_date}} at {{event_location}}.\n\nPlease RSVP at your earliest convenience: {{rsvp_url}}\n\nWarm regards,\nPHW Colorado Alpine Chapter'
    );
GO

IF NOT EXISTS (SELECT 1 FROM [dbo].[notification_template] WHERE name = 'event_reminder' AND channel = 'sms')
    INSERT INTO [dbo].[notification_template] (name, channel, subject, body)
    VALUES (
        'event_reminder', 'sms', NULL,
        'Hi {{first_name}}, reminder: PHW event "{{event_title}}" is on {{event_date}}. RSVP: {{rsvp_url}} Reply STOP to opt out.'
    );
GO