import { NextFunction, Request, Response } from 'express';

interface AppError extends Error {
  statusCode?: number;
}

function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  const statusCode = err.statusCode ?? 500;
  const isDev = process.env['NODE_ENV'] !== 'production';

  res.status(statusCode).json({
    error: {
      message: err.message ?? 'Internal Server Error',
      ...(isDev ? { stack: err.stack } : {}),
    },
  });
}

function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      message: `Route not found: ${req.method} ${req.path}`,
    },
  });
}

export { errorHandler, notFoundHandler };
export type { AppError };