import { getPool, sql } from '../db';

export interface ProgramCatalogRecord {
  program_id: string;
  program_name: string;
  state_name: string;
  sort_order: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  updated_by: string | null;
}

const DEFAULT_COLORADO_STATE = 'Colorado';
const DEFAULT_COLORADO_PROGRAMS = [
  'Northern Colorado',
  'Grand Junction',
  'Colorado Springs',
  'Denver',
  'Montrose - CO',
  'Four Corners',
  'San Luis Valley',
  'Colorado Alpine',
];

function normalizeProgramNameInput(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    return null;
  }

  return normalized;
}

export function normalizeStateNameInput(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > 100) {
    return null;
  }

  return normalized;
}

function dedupeProgramNames(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(value);
  }

  return deduped;
}

export function normalizeProgramNameList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  const normalized = values
    .map((value) => normalizeProgramNameInput(value))
    .filter((value): value is string => Boolean(value));

  return dedupeProgramNames(normalized);
}

export async function ensureProgramCatalogTable(): Promise<void> {
  const pool = await getPool();
  await pool.request().query(`
    IF OBJECT_ID(N'dbo.program_catalog', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.program_catalog (
        program_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        program_name NVARCHAR(200) NOT NULL,
        state_name NVARCHAR(100) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        is_active BIT NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT GETUTCDATE(),
        updated_at DATETIME NOT NULL DEFAULT GETUTCDATE(),
        updated_by NVARCHAR(255) NULL,
        CONSTRAINT PK_program_catalog PRIMARY KEY (program_id)
      );
    END

    IF NOT EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = 'UQ_program_catalog_state_name_program_name'
        AND object_id = OBJECT_ID('dbo.program_catalog')
    )
      CREATE UNIQUE INDEX UQ_program_catalog_state_name_program_name
      ON dbo.program_catalog (state_name, program_name);

    IF NOT EXISTS (
      SELECT 1
      FROM sys.indexes
      WHERE name = 'IX_program_catalog_active_state_sort'
        AND object_id = OBJECT_ID('dbo.program_catalog')
    )
      CREATE INDEX IX_program_catalog_active_state_sort
      ON dbo.program_catalog (is_active, state_name, sort_order, program_name);

    IF NOT EXISTS (SELECT 1 FROM dbo.program_catalog)
    BEGIN
      INSERT INTO dbo.program_catalog (program_id, program_name, state_name, sort_order, is_active, created_at, updated_at, updated_by)
      VALUES
        (NEWID(), N'Northern Colorado', N'Colorado', 10, 1, GETUTCDATE(), GETUTCDATE(), N'system-seed'),
        (NEWID(), N'Grand Junction', N'Colorado', 20, 1, GETUTCDATE(), GETUTCDATE(), N'system-seed'),
        (NEWID(), N'Colorado Springs', N'Colorado', 30, 1, GETUTCDATE(), GETUTCDATE(), N'system-seed'),
        (NEWID(), N'Denver', N'Colorado', 40, 1, GETUTCDATE(), GETUTCDATE(), N'system-seed'),
        (NEWID(), N'Montrose - CO', N'Colorado', 50, 1, GETUTCDATE(), GETUTCDATE(), N'system-seed'),
        (NEWID(), N'Four Corners', N'Colorado', 60, 1, GETUTCDATE(), GETUTCDATE(), N'system-seed'),
        (NEWID(), N'San Luis Valley', N'Colorado', 70, 1, GETUTCDATE(), GETUTCDATE(), N'system-seed'),
        (NEWID(), N'Colorado Alpine', N'Colorado', 80, 1, GETUTCDATE(), GETUTCDATE(), N'system-seed');
    END
  `);
}

export async function listPrograms(options?: {
  stateName?: string | null;
  includeInactive?: boolean;
}): Promise<ProgramCatalogRecord[]> {
  await ensureProgramCatalogTable();

  const pool = await getPool();
  const request = pool.request();
  const where: string[] = [];

  if (!options?.includeInactive) {
    where.push('is_active = 1');
  }

  if (options?.stateName) {
    const normalizedState = normalizeStateNameInput(options.stateName);
    if (!normalizedState) {
      return [];
    }
    request.input('state_name', sql.NVarChar(100), normalizedState);
    where.push('state_name = @state_name');
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const result = await request.query<ProgramCatalogRecord>(
    `SELECT
        program_id,
        program_name,
        state_name,
        sort_order,
        is_active,
        created_at,
        updated_at,
        updated_by
     FROM dbo.program_catalog
     ${whereClause}
     ORDER BY state_name ASC, sort_order ASC, program_name ASC`
  );

  return result.recordset;
}

export async function replaceProgramsForState(args: {
  stateName: string;
  programNames: string[];
  updatedBy: string;
}): Promise<ProgramCatalogRecord[]> {
  const stateName = normalizeStateNameInput(args.stateName);
  if (!stateName) {
    throw new Error('state is required and must be 100 characters or less.');
  }

  const normalizedProgramNames = dedupeProgramNames(
    args.programNames
      .map((name) => normalizeProgramNameInput(name))
      .filter((name): name is string => Boolean(name))
  );

  if (normalizedProgramNames.length === 0) {
    throw new Error('At least one valid program name is required.');
  }

  const updatedBy = (typeof args.updatedBy === 'string' && args.updatedBy.trim())
    ? args.updatedBy.trim().slice(0, 255)
    : 'unknown';

  await ensureProgramCatalogTable();
  const pool = await getPool();
  const transaction = new sql.Transaction(pool);

  await transaction.begin();
  try {
    await new sql.Request(transaction)
      .input('state_name', sql.NVarChar(100), stateName)
      .input('updated_by', sql.NVarChar(255), updatedBy)
      .query(
        `UPDATE dbo.program_catalog
         SET is_active = 0,
             updated_at = GETUTCDATE(),
             updated_by = @updated_by
         WHERE state_name = @state_name`
      );

    for (let index = 0; index < normalizedProgramNames.length; index += 1) {
      const programName = normalizedProgramNames[index];
      const sortOrder = (index + 1) * 10;

      await new sql.Request(transaction)
        .input('state_name', sql.NVarChar(100), stateName)
        .input('program_name', sql.NVarChar(200), programName)
        .input('sort_order', sql.Int, sortOrder)
        .input('updated_by', sql.NVarChar(255), updatedBy)
        .query(
          `IF EXISTS (
             SELECT 1
             FROM dbo.program_catalog
             WHERE state_name = @state_name
               AND program_name = @program_name
           )
             BEGIN
               UPDATE dbo.program_catalog
               SET sort_order = @sort_order,
                   is_active = 1,
                   updated_at = GETUTCDATE(),
                   updated_by = @updated_by
               WHERE state_name = @state_name
                 AND program_name = @program_name;
             END
           ELSE
             BEGIN
               INSERT INTO dbo.program_catalog (
                 program_id,
                 program_name,
                 state_name,
                 sort_order,
                 is_active,
                 created_at,
                 updated_at,
                 updated_by
               )
               VALUES (
                 NEWID(),
                 @program_name,
                 @state_name,
                 @sort_order,
                 1,
                 GETUTCDATE(),
                 GETUTCDATE(),
                 @updated_by
               );
             END`
        );
    }

    await transaction.commit();
  } catch (error) {
    try {
      await transaction.rollback();
    } catch {
      // Ignore rollback errors if the transaction is already closed.
    }
    throw error;
  }

  return listPrograms({ stateName, includeInactive: true });
}

export { DEFAULT_COLORADO_PROGRAMS, DEFAULT_COLORADO_STATE };
