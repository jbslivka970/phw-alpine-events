-- Azure SQL Database Schema for PHW Alpine Events
-- Based on PRD Section 5.1 Data Model

-- ============================================================
-- member
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'member')
BEGIN
  CREATE TABLE member (
      member_id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
      first_name NVARCHAR(100) NOT NULL,
      last_name NVARCHAR(100) NOT NULL,
      email NVARCHAR(255) NOT NULL,
      mobile_phone NVARCHAR(20),
      sms_opt_in BIT DEFAULT 0,
      sms_opt_in_date DATETIME,
      sms_opt_out_date DATETIME,
      email_opt_out BIT DEFAULT 0,
      salutation NVARCHAR(50),
      title NVARCHAR(100),
      account_name NVARCHAR(200),
      source NVARCHAR(10) CHECK (source IN ('import', 'manual')),
      last_import_hash NVARCHAR(64),
      last_manual_edit DATETIME,
      is_active BIT DEFAULT 1,
      created_at DATETIME DEFAULT GETDATE(),
      updated_at DATETIME DEFAULT GETDATE()
  );

  CREATE INDEX idx_member_composite ON member(email, first_name, last_name);
END;

-- ============================================================
-- [group] – square brackets because GROUP is a reserved word
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'group')
BEGIN
  CREATE TABLE [group] (
      group_id   UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
      name       NVARCHAR(200) NOT NULL,
      description NVARCHAR(500),
      is_system  BIT DEFAULT 0,       -- 1 = built-in system group (e.g. "All Members")
      is_active  BIT DEFAULT 1,
      created_at DATETIME DEFAULT GETDATE(),
      updated_at DATETIME DEFAULT GETDATE()
  );

  CREATE INDEX idx_group_name ON [group](name);
END;

-- ============================================================
-- group_member  (many-to-many join)
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'group_member')
BEGIN
  CREATE TABLE group_member (
      group_id   UNIQUEIDENTIFIER NOT NULL REFERENCES [group](group_id),
      member_id  UNIQUEIDENTIFIER NOT NULL REFERENCES member(member_id),
      added_at   DATETIME DEFAULT GETDATE(),
      PRIMARY KEY (group_id, member_id)
  );
END;

-- ============================================================
-- event
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'event')
BEGIN
  CREATE TABLE [event] (
      event_id              UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
      title                 NVARCHAR(200) NOT NULL,
      description           NVARCHAR(MAX),
      event_date            DATETIME NOT NULL,
      location              NVARCHAR(300),
      status                NVARCHAR(20) NOT NULL DEFAULT 'DRAFT'
                              CHECK (status IN ('DRAFT', 'PUBLISHED', 'COMPLETED', 'CANCELLED')),
      mentor_slots          INT NOT NULL DEFAULT 0,
      participant_slots     INT NOT NULL DEFAULT 0,
      mentor_slots_filled   INT NOT NULL DEFAULT 0,
      participant_slots_filled INT NOT NULL DEFAULT 0,
      created_by            NVARCHAR(255),   -- user identifier (email / oid)
      created_at            DATETIME DEFAULT GETDATE(),
      updated_at            DATETIME DEFAULT GETDATE()
  );

  CREATE INDEX idx_event_status ON [event](status);
  CREATE INDEX idx_event_date   ON [event](event_date);
END;

-- ============================================================
-- event_group_target  – which groups are targeted by an event
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'event_group_target')
BEGIN
  CREATE TABLE event_group_target (
      target_id  UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
      event_id   UNIQUEIDENTIFIER NOT NULL REFERENCES [event](event_id) ON DELETE CASCADE,
      group_id   UNIQUEIDENTIFIER NOT NULL REFERENCES [group](group_id),
      notes      NVARCHAR(500),
      created_at DATETIME DEFAULT GETDATE(),
      CONSTRAINT uq_event_group UNIQUE (event_id, group_id)
  );
END;

-- ============================================================
-- rsvp
-- ============================================================
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'rsvp')
BEGIN
  CREATE TABLE rsvp (
      rsvp_id       UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
      event_id      UNIQUEIDENTIFIER NOT NULL REFERENCES [event](event_id) ON DELETE CASCADE,
      member_id     UNIQUEIDENTIFIER NOT NULL REFERENCES member(member_id),
      response      NVARCHAR(10) NOT NULL
                      CHECK (response IN ('YES', 'NO', 'MAYBE', 'WAITLIST')),
      role          NVARCHAR(20) NOT NULL DEFAULT 'participant'
                      CHECK (role IN ('mentor', 'participant')),
      group_id      UNIQUEIDENTIFIER REFERENCES [group](group_id),  -- per-group context
      group_context NVARCHAR(MAX),                                   -- JSON blob for extra per-group data
      notes         NVARCHAR(500),
      created_at    DATETIME DEFAULT GETDATE(),
      updated_at    DATETIME DEFAULT GETDATE(),
      CONSTRAINT uq_rsvp_event_member UNIQUE (event_id, member_id)
  );

  CREATE INDEX idx_rsvp_event    ON rsvp(event_id);
  CREATE INDEX idx_rsvp_member   ON rsvp(member_id);
  CREATE INDEX idx_rsvp_response ON rsvp(response);
END;