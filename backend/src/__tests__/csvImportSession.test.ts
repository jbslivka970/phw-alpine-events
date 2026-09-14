import { getPool } from '../db';
import {
  claimPreviewSession,
  releasePreviewSessionClaim,
  storePreviewSession,
} from '../services/csvImportService';

jest.mock('../db', () => ({
  getPool: jest.fn(),
  sql: {
    MAX: 'MAX',
    Int: 'Int',
    UniqueIdentifier: 'UniqueIdentifier',
    NVarChar: jest.fn((length: unknown) => `NVarChar(${String(length)})`),
  },
}));

type RequestMock = {
  params: Record<string, unknown>;
  input: jest.Mock;
  query: jest.Mock;
};

function mockRequestResults(results: Array<{ recordset?: unknown[]; rowsAffected?: number[] }>) {
  const requests: RequestMock[] = [];
  (getPool as jest.Mock).mockResolvedValue({
    request: () => {
      const request: RequestMock = {
        params: {},
        input: jest.fn(function (this: RequestMock, name: string, _type: unknown, value: unknown) {
          this.params[name] = value;
          return this;
        }),
        query: jest.fn().mockImplementation(async () => results.shift() ?? { recordset: [] }),
      };
      requests.push(request);
      return request;
    },
  });
  return requests;
}

const owner = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: 'user-object-id-1',
};

const preview = {
  sessionId: '22222222-2222-4222-8222-222222222222',
  tenantId: owner.tenantId,
  fileName: 'members.csv',
  totalRows: 0,
  newRows: 0,
  updatedRows: 0,
  unchangedRows: 0,
  conflictRows: 0,
  skippedRows: 0,
  errorRows: 0,
  rows: [],
  absentMembers: [],
  createdAt: new Date('2026-09-14T00:00:00.000Z'),
};

describe('SQL CSV import sessions', () => {
  beforeEach(() => jest.clearAllMocks());

  it('stores normalized preview payload with tenant and user ownership', async () => {
    const requests = mockRequestResults([{ rowsAffected: [1] }]);

    await storePreviewSession(preview, owner);

    expect(requests[0]?.params).toMatchObject({
      session_id: preview.sessionId,
      tenant_id: owner.tenantId,
      owner_user_id: owner.userId,
      import_kind: 'members_csv',
    });
    expect(requests[0]?.query.mock.calls[0]?.[0]).toContain('INSERT INTO dbo.csv_import_session');
  });

  it('allows only one atomic owned claim and rejects a concurrent duplicate', async () => {
    const claimToken = '33333333-3333-4333-8333-333333333333';
    const requests = mockRequestResults([
      { recordset: [{ preview_payload: JSON.stringify(preview), claim_token: claimToken }] },
      { recordset: [] },
    ]);

    await expect(claimPreviewSession(preview.sessionId, owner)).resolves.toMatchObject({ claimToken });
    await expect(claimPreviewSession(preview.sessionId, owner)).resolves.toBeNull();

    const claimSql = requests[0]?.query.mock.calls[0]?.[0] as string;
    expect(claimSql).toContain('WITH (UPDLOCK, ROWLOCK)');
    expect(claimSql).toContain('tenant_id = @tenant_id');
    expect(claimSql).toContain('owner_user_id = @owner_user_id');
    expect(claimSql).toContain('committed_at IS NULL');
    expect(claimSql).toContain('expires_at > @now');
  });

  it('releases only the matching uncommitted owned claim', async () => {
    const requests = mockRequestResults([{ rowsAffected: [1] }]);

    await releasePreviewSessionClaim(
      preview.sessionId,
      owner,
      '33333333-3333-4333-8333-333333333333'
    );

    const releaseSql = requests[0]?.query.mock.calls[0]?.[0] as string;
    expect(releaseSql).toContain('claim_token = @claim_token');
    expect(releaseSql).toContain('owner_user_id = @owner_user_id');
    expect(releaseSql).toContain('committed_at IS NULL');
  });
});