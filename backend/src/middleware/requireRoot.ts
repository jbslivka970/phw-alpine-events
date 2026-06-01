import type { NextFunction, Request, Response } from 'express';
import { getPool, sql } from '../db';

async function requireRoot(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const normalizedEmail = req.user.email?.trim().toLowerCase() ?? null;

  try {
    const pool = await getPool();
    const result = await pool
      .request()
      .input('oid', sql.NVarChar(255), req.user.sub)
      .input('email', sql.NVarChar(255), normalizedEmail)
      .query<{ is_root: boolean | number | null }>(
        `SELECT TOP (1) is_root
         FROM dbo.[user]
         WHERE is_active = 1
           AND (
             (@oid IS NOT NULL AND azure_oid = @oid)
             OR (@email IS NOT NULL AND LOWER(email) = @email)
           )`
      );

    const isRoot = result.recordset[0]?.is_root;
    if (!(isRoot === true || isRoot === 1)) {
      res.status(403).json({ error: 'Root admin access required' });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}

export { requireRoot };
