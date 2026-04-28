import { getPool, sql } from '../db';

export const SUPPORTED_PERSONAS = ['participant', 'volunteer', 'mentor', 'guide', 'staff'] as const;
export type Persona = typeof SUPPORTED_PERSONAS[number];

export function normalizePersona(value: unknown): Persona | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return (SUPPORTED_PERSONAS as readonly string[]).includes(trimmed) ? (trimmed as Persona) : null;
}

export async function listPersonasForMember(memberId: string): Promise<Persona[]> {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('member_id', sql.UniqueIdentifier, memberId)
    .query<{ persona: string }>(
      `SELECT persona FROM dbo.member_persona WHERE member_id = @member_id ORDER BY persona;`
    );
  return result.recordset
    .map((r) => normalizePersona(r.persona))
    .filter((p): p is Persona => p !== null);
}

/**
 * Replaces the persona set for a member (idempotent).  `grantedByUserId` is
 * recorded for audit; pass null when the change is system-driven.
 */
export async function setPersonasForMember(
  memberId: string,
  personas: Persona[],
  grantedByUserId: string | null
): Promise<Persona[]> {
  const dedup = Array.from(new Set(personas));
  const pool = await getPool();
  const tx = pool.transaction();
  await tx.begin();
  try {
    await tx.request()
      .input('member_id', sql.UniqueIdentifier, memberId)
      .query(`DELETE FROM dbo.member_persona WHERE member_id = @member_id;`);

    for (const persona of dedup) {
      await tx.request()
        .input('member_id', sql.UniqueIdentifier, memberId)
        .input('persona', sql.NVarChar(40), persona)
        .input('granted_by', sql.UniqueIdentifier, grantedByUserId)
        .query(
          `INSERT INTO dbo.member_persona (member_id, persona, granted_by)
           VALUES (@member_id, @persona, @granted_by);`
        );
    }
    await tx.commit();
    return dedup;
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
