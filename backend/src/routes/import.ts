import crypto from 'crypto';
import { Request, Response, Router } from 'express';
import multer from 'multer';
import authenticate from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/rbac';
import {
  claimPreviewSession,
  commitImport,
  generatePreview,
  getImportLogRowErrors,
  getImportLogs,
  getImportLogReport,
  storePreviewSession,
} from '../services/csvImportService';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv')) {
      cb(null, true);
      return;
    }
    cb(new Error('Only CSV files are accepted'));
  },
});

router.post('/preview', writeLimiter, authenticate, requireAdmin, upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded. Expected multipart/form-data with field file.' });
      return;
    }

    const sessionId = crypto.randomUUID();
    if (!req.tenantId) {
      res.status(400).json({ error: 'An active tenant is required for member import.' });
      return;
    }

    const ownerUserId = req.user?.sub;
    if (!ownerUserId) {
      res.status(400).json({ error: 'An authenticated user is required for member import.' });
      return;
    }

    const preview = await generatePreview(req.file.buffer, req.file.originalname, sessionId, req.tenantId);
    await storePreviewSession(preview, { tenantId: req.tenantId, userId: ownerUserId });

    res.status(200).json({
      sessionId: preview.sessionId,
      fileName: preview.fileName,
      summary: {
        totalRows: preview.totalRows,
        newRows: preview.newRows,
        updatedRows: preview.updatedRows,
        unchangedRows: preview.unchangedRows,
        conflictRows: preview.conflictRows,
        skippedRows: preview.skippedRows,
        errorRows: preview.errorRows,
      },
      rows: preview.rows,
      absentMembers: preview.absentMembers,
    });
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Preview failed' });
  }
});

router.post('/commit/:sessionId', writeLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const owner = { tenantId: req.tenantId ?? '', userId: req.user?.sub ?? '' };
    const claimed = await claimPreviewSession(req.params.sessionId, owner);
    if (!claimed) {
      res.status(404).json({ error: 'Session not found, expired, committed, or already in progress.' });
      return;
    }

    const result = await commitImport(claimed.preview, {
      tenantId: owner.tenantId,
      ownerUserId: owner.userId,
      claimToken: claimed.claimToken,
      conflictResolutions: (req.body as { conflictResolutions?: Record<string, 'create' | 'skip'> } | undefined)
        ?.conflictResolutions,
      importedByUserId: req.user?.sub ?? null,
      importedByEmail: req.user?.email ?? null,
    });

    res.status(200).json(result);
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Commit failed' });
  }
});

router.get('/logs', writeLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const startedFromRaw = typeof req.query.started_from === 'string' ? req.query.started_from : undefined;
    const startedToRaw = typeof req.query.started_to === 'string' ? req.query.started_to : undefined;
    const importedBy = typeof req.query.imported_by === 'string' ? req.query.imported_by.trim() : undefined;

    const startedFrom = startedFromRaw ? new Date(startedFromRaw) : undefined;
    const startedTo = startedToRaw ? new Date(startedToRaw) : undefined;

    if (startedFrom && Number.isNaN(startedFrom.getTime())) {
      res.status(400).json({ error: 'started_from must be a valid date' });
      return;
    }
    if (startedTo && Number.isNaN(startedTo.getTime())) {
      res.status(400).json({ error: 'started_to must be a valid date' });
      return;
    }

    const logs = await getImportLogs(100, {
      tenantId: req.tenantId ?? '',
      startedFrom,
      startedTo,
      importedBy: importedBy || undefined,
    });
    res.status(200).json({ logs });
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch logs' });
  }
});

router.get('/logs/:importId/report.csv', writeLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const report = await getImportLogReport(req.params.importId, req.tenantId ?? '');
    if (!report) {
      res.status(404).json({ error: 'Import log not found' });
      return;
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${report.fileName}"`);
    res.status(200).send(report.csv);
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to generate report' });
  }
});

router.get('/logs/:importId/errors', writeLimiter, authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const errors = await getImportLogRowErrors(req.params.importId, req.tenantId ?? '');
    res.status(200).json({ errors });
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch row errors' });
  }
});

export default router;