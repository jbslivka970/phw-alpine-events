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

  it('GET /api/import/logs returns logs', async () => {
    (csvImportService.getImportLogs as jest.Mock).mockResolvedValue([
      { importId: 'import-1', status: 'completed' },
    ]);

    const res = await request(app).get('/api/import/logs');

    expect(res.status).toBe(200);
    expect(res.body.logs).toEqual([{ importId: 'import-1', status: 'completed' }]);
  });
});
