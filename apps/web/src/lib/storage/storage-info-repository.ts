/**
 * DB access for GET /api/storage/info (#2155). Fetches the same `files` rows
 * (createdBy = userId) that the charge/reconcile basis uses, each joined to
 * one representative page (most recently created FILE page linking that
 * blob, if any) for display — the file itself, not the page, is the unit of
 * storage.
 */

import { db } from '@pagespace/db/db';
import { sql } from '@pagespace/db/operators';
import type { UserFileRow } from './storage-info-core';

interface RawUserFileRow extends Record<string, unknown> {
  fileId: string;
  sizeBytes: number | string;
  mimeType: string | null;
  createdAt: string | Date;
  driveId: string | null;
  pageId: string | null;
  title: string | null;
  pageDriveId: string | null;
}

export async function findUserFileRows(userId: string): Promise<UserFileRow[]> {
  // pageDriveId is the REPRESENTATIVE PAGE's own drive (pages.driveId), which
  // can differ from files.driveId (the blob's original creation drive) once a
  // file is dedup-linked into a second drive and that second drive's page
  // happens to be more recent — the caller must gate title/id display on THIS
  // field's current access, not files.driveId (#2225 review).
  const result = await db.execute<RawUserFileRow>(sql`
    SELECT f.id AS "fileId",
           f."sizeBytes" AS "sizeBytes",
           f."mimeType" AS "mimeType",
           f."createdAt" AS "createdAt",
           f."driveId" AS "driveId",
           p.id AS "pageId",
           p.title AS "title",
           p."driveId" AS "pageDriveId"
    FROM files f
    LEFT JOIN LATERAL (
      SELECT pg.id, pg.title, pg."driveId"
      FROM file_pages fp
      JOIN pages pg ON pg.id = fp."pageId" AND pg.type = 'FILE' AND pg."isTrashed" = false
      WHERE fp."fileId" = f.id
      ORDER BY pg."createdAt" DESC
      LIMIT 1
    ) p ON true
    WHERE f."createdBy" = ${userId}
  `);

  return result.rows.map((row) => ({
    fileId: row.fileId,
    sizeBytes: typeof row.sizeBytes === 'string' ? Number(row.sizeBytes) : row.sizeBytes,
    mimeType: row.mimeType,
    createdAt: new Date(row.createdAt),
    driveId: row.driveId,
    pageId: row.pageId,
    title: row.title,
    pageDriveId: row.pageDriveId,
  }));
}
