import { Router, Request, Response } from 'express';
import multer from 'multer';
import * as crypto from 'crypto';
import {
  generatePreview,
  storePreviewSession,
  getPreviewSession,
  deletePreviewSession,
  commitImport,
  getImportLogs,
  getImportLogRowErrors,
} from '../services/csvImportService';

const router = Router();

// 5 MB limit for CSV uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (
      file.mimetype === 'text/csv' ||
      file.originalname.endsWith('.csv')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are accepted'));
    }
  },
});

// ----------------------------------------------------------------
// POST /api/v1/import/preview
// Upload a CSV and receive a preview + sessionId
// ----------------------------------------------------------------
router.post('/preview', upload.single('file'), async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded. Send a CSV as multipart/form-data field "file".' });
      return;
    }

    const sessionId = crypto.randomUUID();
    const preview = await generatePreview(
      req.file.buffer,
      req.file.originalname,
      sessionId,
    );

    storePreviewSession(preview);

    res.status(200).json({
      sessionId: preview.sessionId,
      fileName: preview.fileName,
      summary: {
        totalRows: preview.totalRows,
        newRows: preview.newRows,
        updatedRows: preview.updatedRows,
        unchangedRows: preview.unchangedRows,
        skippedRows: preview.skippedRows,
        errorRows: preview.errorRows,
        sharedEmailCount: preview.sharedEmailCount,
      },
      rows: preview.rows,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Preview failed';
    res.status(500).json({ error: message });
  }
});

// ----------------------------------------------------------------
// POST /api/v1/import/commit/:sessionId
// Commit a previously previewed import
// ----------------------------------------------------------------
router.post('/commit/:sessionId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { sessionId } = req.params;
    const preview = getPreviewSession(sessionId);

    if (!preview) {
      res.status(404).json({ error: 'Session not found or expired. Re-upload the CSV.' });
      return;
    }

    // importedBy could come from auth middleware; fall back to request body or header
    const importedBy: string =
      (req.body as { importedBy?: string }).importedBy ??
      (req.headers['x-imported-by'] as string | undefined) ??
      'unknown';

    const result = await commitImport(preview, importedBy);
    deletePreviewSession(sessionId);

    res.status(200).json({
      importLogId: result.importLogId,
      committed: result.committed,
      errors: result.errors,
      rowErrors: result.rowErrors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Commit failed';
    res.status(500).json({ error: message });
  }
});

// ----------------------------------------------------------------
// GET /api/v1/import/logs
// Return import history
// ----------------------------------------------------------------
router.get('/logs', async (_req: Request, res: Response): Promise<void> => {
  try {
    const logs = await getImportLogs();
    res.status(200).json({ logs });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch logs';
    res.status(500).json({ error: message });
  }
});

// ----------------------------------------------------------------
// GET /api/v1/import/logs/:importLogId/errors
// Return row-level errors for a specific import
// ----------------------------------------------------------------
router.get('/logs/:importLogId/errors', async (req: Request, res: Response): Promise<void> => {
  try {
    const { importLogId } = req.params;
    const errors = await getImportLogRowErrors(importLogId);
    res.status(200).json({ errors });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch errors';
    res.status(500).json({ error: message });
  }
});

export default router;
