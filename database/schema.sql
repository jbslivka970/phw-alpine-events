-- Azure SQL Database Schema for PHW Alpine Events
-- Based on PRD Section 5.1 Data Model

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

CREATE INDEX idx_member_email ON member(email);
-- Composite matching key per PRD: email + first_name + last_name.
-- Email is always stored lowercase (enforced by service layer), so the index is case-consistent.
CREATE UNIQUE INDEX idx_member_composite ON member(email, first_name, last_name);

-- Groups (custom and system)
CREATE TABLE [group] (
    group_id UNIQUEIDENTIFIER PRIMARY KEY DEFAULT NEWID(),
    name NVARCHAR(100) NOT NULL,
    description NVARCHAR(500),
    is_system BIT DEFAULT 0 NOT NULL,
    created_at DATETIME DEFAULT GETDATE(),
    updated_at DATETIME DEFAULT GETDATE()
);

CREATE UNIQUE INDEX idx_group_name ON [group](name);

-- Member-Group junction table
CREATE TABLE member_group (
    member_id UNIQUEIDENTIFIER NOT NULL REFERENCES member(member_id),
    group_id  UNIQUEIDENTIFIER NOT NULL REFERENCES [group](group_id),
    assigned_at DATETIME DEFAULT GETDATE(),
    CONSTRAINT pk_member_group PRIMARY KEY (member_id, group_id)
);

CREATE INDEX idx_member_group_group ON member_group(group_id);

-- Seed system groups (idempotent – use MERGE)
MERGE [group] AS target
USING (VALUES
    ('All Members',       'Automatically includes all active members.',     1),
    ('SMS Opt-In',        'Members who have opted in to SMS notifications.',1),
    ('Email Opt-In',      'Members who have not opted out of email.',       1)
) AS source (name, description, is_system)
ON target.name = source.name
WHEN NOT MATCHED THEN
    INSERT (name, description, is_system) VALUES (source.name, source.description, source.is_system);