-- Azure SQL Database Schema for PHW Alpine Events
-- Based on PRD Section 5.1 Data Model

-- ------------------------------------------------------------
-- Member
-- ------------------------------------------------------------
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
      participant_status NVARCHAR(100),
      volunteer_status NVARCHAR(100),
      source NVARCHAR(10) CHECK (source IN ('import', 'manual')),
      last_import_hash NVARCHAR(64),
      last_manual_edit DATETIME,
      is_active BIT DEFAULT 1,
      created_at DATETIME DEFAULT GETDATE(),
      updated_at DATETIME DEFAULT GETDATE()
  );
  CREATE INDEX idx_member_email ON member(email);
  CREATE INDEX idx_member_composite ON member(email, first_name, last_name);
END;

-- ------------------------------------------------------------
-- Group
-- ------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'member_group')
BEGIN
  CREATE TABLE member_group (
      group_id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
      group_name NVARCHAR(100) NOT NULL,
      description NVARCHAR(500),
      is_system BIT DEFAULT 0,
      created_at DATETIME DEFAULT GETDATE(),
      updated_at DATETIME DEFAULT GETDATE()
  );
  CREATE UNIQUE INDEX idx_group_name ON member_group(group_name);
END;

-- ------------------------------------------------------------
-- Group Membership
-- ------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'group_member')
BEGIN
  CREATE TABLE group_member (
      group_member_id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
      group_id UNIQUEIDENTIFIER NOT NULL REFERENCES member_group(group_id),
      member_id UNIQUEIDENTIFIER NOT NULL REFERENCES member(member_id),
      created_at DATETIME DEFAULT GETDATE(),
      CONSTRAINT uq_group_member UNIQUE (group_id, member_id)
  );
  CREATE INDEX idx_group_member_member ON group_member(member_id);
  CREATE INDEX idx_group_member_group ON group_member(group_id);
END;

-- ------------------------------------------------------------
-- Import Log (one row per CSV upload/commit)
-- ------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'import_log')
BEGIN
  CREATE TABLE import_log (
      import_log_id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
      file_name NVARCHAR(255),
      imported_by NVARCHAR(255),
      total_rows INT DEFAULT 0,
      new_rows INT DEFAULT 0,
      updated_rows INT DEFAULT 0,
      skipped_rows INT DEFAULT 0,
      error_rows INT DEFAULT 0,
      status NVARCHAR(20) CHECK (status IN ('preview', 'committed', 'failed')) DEFAULT 'preview',
      created_at DATETIME DEFAULT GETDATE(),
      committed_at DATETIME
  );
END;

-- ------------------------------------------------------------
-- Import Row Error (one row per failing CSV row)
-- ------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'import_row_error')
BEGIN
  CREATE TABLE import_row_error (
      error_id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
      import_log_id UNIQUEIDENTIFIER NOT NULL REFERENCES import_log(import_log_id),
      row_number INT,
      row_data NVARCHAR(MAX),
      error_message NVARCHAR(500),
      created_at DATETIME DEFAULT GETDATE()
  );
  CREATE INDEX idx_row_error_import ON import_row_error(import_log_id);
END;

-- ------------------------------------------------------------
-- Seed system groups
-- ------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM member_group WHERE group_name = 'Participants')
  INSERT INTO member_group (group_name, description, is_system) VALUES ('Participants', 'Members with a Participant Status', 1);

IF NOT EXISTS (SELECT 1 FROM member_group WHERE group_name = 'Volunteers')
  INSERT INTO member_group (group_name, description, is_system) VALUES ('Volunteers', 'Members with a Volunteer Status', 1);