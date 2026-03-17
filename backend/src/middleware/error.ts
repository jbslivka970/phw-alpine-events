import { Request, Response, NextFunction } from 'express';

export interface AppError extends Error {
  statusCode?: number;
  isOperational?: boolean;
}

/**
 * Centralized error handler middleware.
 * Must be registered last (after all routes) with four parameters so Express
 * recognises it as an error-handling middleware.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode = err.statusCode ?? 500;
  const isDev = process.env['NODE_ENV'] !== 'production';

  res.status(statusCode).json({
    error: {
      message: err.message ?? 'Internal Server Error',
      ...(isDev && { stack: err.stack }),
    },
  });
}

/**
 * Catch-all handler for routes that do not exist.
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { message: `Route not found: ${req.method} ${req.path}` } });
}
