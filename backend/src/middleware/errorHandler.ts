import { Request, Response, NextFunction } from 'express';

export interface ApiError extends Error {
  status?: number;
}

/**
 * Global error handler.  Must have four parameters so Express recognises it as
 * an error-handling middleware.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: ApiError, req: Request, res: Response, _next: NextFunction): void {
  const status = err.status || 500;
  const message = err.message || 'Internal Server Error';

  if (status >= 500) {
    console.error('[error]', err);
  }

  res.status(status).json({ error: message });
}
