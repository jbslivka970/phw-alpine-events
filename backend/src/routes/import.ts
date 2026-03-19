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
    });
    deletePreviewSession(req.params.sessionId);

    res.status(200).json(result);
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Commit failed' });
  }
});

router.get('/logs', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  try {
    const logs = await getImportLogs();
    res.status(200).json({ logs });
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch logs' });
  }
});

router.get('/logs/:importId/errors', authenticate, requireAdmin, async (req: Request, res: Response) => {
  try {
    const errors = await getImportLogRowErrors(req.params.importId);
    res.status(200).json({ errors });
  } catch (error: unknown) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to fetch row errors' });
  }
});

export default router;