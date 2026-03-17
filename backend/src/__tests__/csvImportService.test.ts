import { parseCsvBuffer, computeRowHash, generatePreview, CsvRow } from '../services/csvImportService';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCsv(rows: string[]): Buffer {
  const header = 'First Name,Last Name,Email,Mobile Phone,Salutation,Title,Account Name,Participant Status,Volunteer Status,SMS Opt In';
  return Buffer.from([header, ...rows].join('\n'), 'utf8');
}

// ---------------------------------------------------------------------------
// parseCsvBuffer
// ---------------------------------------------------------------------------

describe('parseCsvBuffer', () => {
  it('parses a well-formed CSV', () => {
    const buf = makeCsv(['Jane,Doe,jane@example.com,720-555-1234,,,,Participant,,true']);
    const rows = parseCsvBuffer(buf);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.firstName).toBe('Jane');
    expect(row.lastName).toBe('Doe');
    expect(row.email).toBe('jane@example.com');
    expect(row.mobilePhone).toBe('7205551234');
    expect(row.participantStatus).toBe('Participant');
    expect(row.smsOptIn).toBe(true);
  });

  it('normalises email to lower-case', () => {
    const buf = makeCsv(['Bob,Smith,BOB@EXAMPLE.COM,,,,,,,']);
    const [row] = parseCsvBuffer(buf);
    expect(row.email).toBe('bob@example.com');
  });

  it('strips non-digit characters from phone and removes leading country code', () => {
    const buf = makeCsv(['Alice,Jones,alice@ex.com,+1 (303) 444-5678,,,,,,' ]);
    const [row] = parseCsvBuffer(buf);
    expect(row.mobilePhone).toBe('3034445678');
  });

  it('returns empty array for empty CSV (header only)', () => {
    const buf = Buffer.from('First Name,Last Name,Email\n', 'utf8');
    expect(parseCsvBuffer(buf)).toHaveLength(0);
  });

  it('assigns rowNumber starting at 2', () => {
    const buf = makeCsv([
      'A,B,a@x.com,,,,,,,',
      'C,D,c@x.com,,,,,,,',
    ]);
    const rows = parseCsvBuffer(buf);
    expect(rows[0].rowNumber).toBe(2);
    expect(rows[1].rowNumber).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// computeRowHash
// ---------------------------------------------------------------------------

describe('computeRowHash', () => {
  const base: CsvRow = {
    rowNumber: 2,
    firstName: 'Jane',
    lastName: 'Doe',
    email: 'jane@example.com',
    mobilePhone: '7205551234',
    salutation: '',
    title: '',
    accountName: 'PHW',
    participantStatus: 'Participant',
    volunteerStatus: '',
    smsOptIn: false,
  };

  it('returns a 64-character hex string', () => {
    const hash = computeRowHash(base);
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it('is deterministic', () => {
    expect(computeRowHash(base)).toBe(computeRowHash({ ...base }));
  });

  it('changes when any field changes', () => {
    expect(computeRowHash(base)).not.toBe(computeRowHash({ ...base, firstName: 'John' }));
    expect(computeRowHash(base)).not.toBe(computeRowHash({ ...base, email: 'other@example.com' }));
    expect(computeRowHash(base)).not.toBe(computeRowHash({ ...base, smsOptIn: true }));
  });

  it('is case-insensitive for email', () => {
    const lower = computeRowHash({ ...base, email: 'jane@example.com' });
    const upper = computeRowHash({ ...base, email: 'JANE@EXAMPLE.COM' });
    expect(lower).toBe(upper);
  });
});

// ---------------------------------------------------------------------------
// generatePreview (offline – no DB)
// ---------------------------------------------------------------------------

describe('generatePreview', () => {
  it('marks all rows as "new" when DB is unavailable', async () => {
    const buf = makeCsv([
      'Jane,Doe,jane@example.com,,,,,Participant,,true',
      'Bob,Smith,bob@example.com,,,,,,Volunteer,',
    ]);
    const preview = await generatePreview(buf, 'test.csv', 'session-1');

    expect(preview.totalRows).toBe(2);
    expect(preview.newRows).toBe(2);
    expect(preview.errorRows).toBe(0);
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows.every((r) => r.action === 'new')).toBe(true);
  });

  it('flags shared emails within the CSV', async () => {
    const buf = makeCsv([
      'Jane,Doe,shared@example.com,,,,,,,',
      'Jane,Smith,shared@example.com,,,,,,,',
    ]);
    const preview = await generatePreview(buf, 'test.csv', 'session-2');

    expect(preview.sharedEmailCount).toBe(2);
    expect(preview.rows.every((r) => r.sharedEmail)).toBe(true);
  });

  it('marks a row as "error" when email is missing', async () => {
    const buf = makeCsv(['Jane,Doe,,,,,,,,']);
    const preview = await generatePreview(buf, 'test.csv', 'session-3');

    expect(preview.errorRows).toBe(1);
    expect(preview.rows[0].action).toBe('error');
    expect(preview.rows[0].errorMessage).toMatch(/email/i);
  });

  it('returns correct session metadata', async () => {
    const buf = makeCsv(['A,B,a@x.com,,,,,,,']);
    const preview = await generatePreview(buf, 'upload.csv', 'my-session');

    expect(preview.sessionId).toBe('my-session');
    expect(preview.fileName).toBe('upload.csv');
    expect(preview.createdAt).toBeInstanceOf(Date);
  });
});
