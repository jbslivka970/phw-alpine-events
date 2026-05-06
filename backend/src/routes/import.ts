import crypto from 'crypto';
import { Request, Response, Router } from 'express';
import multer from 'multer';
import authenticate from '../middleware/auth';
import { writeLimiter } from '../middleware/rateLimiter';
import { requireAdmin } from '../middleware/rbac';
import {
  commitImport,
  deletePreviewSession,
  generatePreview,
  getImportLogRowErrors,
  getImportLogs,
  getImportLogReport,
  getPreviewSession,
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
    const preview = await generatePreview(req.file.buffer, req.file.originalname, sessionId);
    storePreviewSession(preview);

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
    const preview = getPreviewSession(req.params.sessionId);
    if (!preview) {
      res.status(404).json({ error: 'Session not found or expired.' });
      return;
    }

    const result = await commitImport(preview, {
      conflictResolutions: (req.body as { conflictResolutions?: Record<string, 'create' | 'skip'> } | undefined)
        ?.conflictResolutions,
      importedByUserId: req.user?.sub ?? null,
      importedByEmail: req.user?.email ?? null,
    });
    deletePreviewSession(req.params.sessionId);

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
    const report = await getImportLogReport(req.params.importId);
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
    const errors = await getImportLogRowErrors(req.params.importId);
    res.status(200).json({ errors });
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch row errors' });
  }
});

export default router;