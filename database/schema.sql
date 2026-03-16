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

-- Add more tables as per PRD...

-- Indexes and constraints
CREATE INDEX idx_member_email ON member(email);
CREATE INDEX idx_member_composite ON member(email, first_name, last_name);

-- System groups seeded separately