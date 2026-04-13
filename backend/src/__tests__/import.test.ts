import express from 'express';
import request from 'supertest';
import importRouter from '../routes/import';
import * as csvImportService from '../services/csvImportService';

jest.mock('../services/csvImportService');

jest.mock('../middleware/auth', () => ({
  __esModule: true,
  default: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = {
      sub: '00000000-0000-0000-0000-000000000001',
      email: 'admin@example.com',
      roles: ['ADMIN'],
      rawClaims: {},
    };
    next();
  },
}));

jest.mock('../middleware/rateLimiter', () => ({
  apiLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  writeLimiter: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

describe('import routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/import', importRouter);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POST /api/import/preview returns 400 if file missing', async () => {
    const res = await request(app).post('/api/import/preview').field('note', 'missing-file');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('No file uploaded');
  });

  it('POST /api/import/commit/:sessionId returns 404 for unknown session', async () => {
    (csvImportService.getPreviewSession as jest.Mock).mockReturnValue(null);

    const res = await request(app).post('/api/import/commit/session-1').send({});

    expect(res.status).toBe(404);
  });

  it('POST /api/import/commit/:sessionId forwards conflict resolutions', async () => {
    (csvImportService.getPreviewSession as jest.Mock).mockReturnValue({
      sessionId: 'session-1',
      fileName: 'members.csv',
      rows: [],
    });
    (csvImportService.commitImport as jest.Mock).mockResolvedValue({
      importId: 'import-1',
      committed: 1,
      errors: 0,
      rowErrors: [],
      summary: {
        totalRows: 1,
        newRows: 1,
        updatedRows: 0,
        unchangedRows: 0,
        conflictRows: 1,
        skippedRows: 0,
        errorRows: 0,
      },
    });

    const res = await request(app)
      .post('/api/import/commit/session-1')
      .send({ conflictResolutions: { '12': 'create' } });

    expect(res.status).toBe(200);
    expect(csvImportService.commitImport).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      {
        conflictResolutions: { '12': 'create' },
        importedByEmail: 'admin@example.com',
        importedByUserId: '00000000-0000-0000-0000-000000000001',
      }
    );
  });

  it('GET /api/import/logs returns logs', async () => {
    (csvImportService.getImportLogs as jest.Mock).mockResolvedValue([
      { importId: 'import-1', status: 'completed' },
    ]);

    const res = await request(app).get('/api/import/logs');

    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual([{ importId: 'import-1', status: 'completed' }]);
  });

  it('GET /api/import/logs forwards filters', async () => {
    (csvImportService.getImportLogs as jest.Mock).mockResolvedValue([]);

    const res = await request(app).get('/api/import/logs?started_from=2026-03-01&started_to=2026-03-31&imported_by=admin@example.com');

    expect(res.status).toBe(200);
    expect(csvImportService.getImportLogs).toHaveBeenCalledWith(
      100,
      expect.objectContaining({
        importedBy: 'admin@example.com',
      })
    );
  });

  it('GET /api/import/logs/:importId/report.csv returns CSV attachment', async () => {
    (csvImportService.getImportLogReport as jest.Mock).mockResolvedValue({
      fileName: 'members-report.csv',
      csv: 'section,key,value\nsummary,import_id,"import-1"',
    });

    const res = await request(app).get('/api/import/logs/import-1/report.csv');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('members-report.csv');
    expect(res.text).toContain('summary,import_id');
  });
});
