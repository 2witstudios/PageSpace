import { db } from '@pagespace/db/db';
import { eq, and } from '@pagespace/db/operators';
import { driveBackups, driveBackupPages, pageVersions } from '@pagespace/db/schema/versioning';
import { isDriveOwnerOrAdmin } from '@pagespace/lib/permissions/permissions';
import { readPageContent } from '@pagespace/lib/services/page-content-store';
import archiver from 'archiver';
import { PassThrough } from 'node:stream';

export type ExportManifestPage = {
  pageId: string;
  title: string | null;
  type: string | null;
  parentId: string | null;
  position: number | null;
  isTrashed: boolean;
  hasContent: boolean;
  filename: string;
};

export type ExportManifest = {
  backupId: string;
  driveId: string;
  exportedAt: string;
  label: string | null;
  pages: ExportManifestPage[];
};

type PageInput = {
  pageId: string;
  title: string | null;
  type: string | null;
  parentId: string | null;
  position: number | null;
  isTrashed: boolean;
  pageVersionId: string | null;
};

export function buildExportManifest(
  backup: { id: string; driveId: string; label: string | null },
  exportedAt: string,
  pages: PageInput[],
): ExportManifest {
  return {
    backupId: backup.id,
    driveId: backup.driveId,
    exportedAt,
    label: backup.label,
    pages: pages.map(p => ({
      pageId: p.pageId,
      title: p.title,
      type: p.type,
      parentId: p.parentId,
      position: p.position,
      isTrashed: p.isTrashed,
      hasContent: p.pageVersionId !== null,
      filename: `${p.pageId}.txt`,
    })),
  };
}

class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const CONCURRENCY_CAP = 10;

async function withConcurrencyLimit<T>(
  items: T[],
  fn: (item: T) => Promise<void>,
  limit: number,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item !== undefined) await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function streamBackupExport(
  backupId: string,
  driveId: string,
  userId: string,
): Promise<AsyncGenerator<Buffer>> {
  // Eagerly validate before any streaming begins so 403/400 can be returned as JSON
  const isAdmin = await isDriveOwnerOrAdmin(userId, driveId);
  if (!isAdmin) {
    throw new HttpError(403, 'Access denied');
  }

  const backup = await db.query.driveBackups.findFirst({
    where: and(eq(driveBackups.id, backupId), eq(driveBackups.driveId, driveId)),
  });

  if (!backup) {
    throw new HttpError(400, 'Backup not found');
  }

  const pageRows = await db
    .select({
      pageId: driveBackupPages.pageId,
      title: driveBackupPages.title,
      type: driveBackupPages.type,
      parentId: driveBackupPages.parentId,
      position: driveBackupPages.position,
      isTrashed: driveBackupPages.isTrashed,
      pageVersionId: driveBackupPages.pageVersionId,
      contentRef: pageVersions.contentRef,
    })
    .from(driveBackupPages)
    .leftJoin(pageVersions, eq(driveBackupPages.pageVersionId, pageVersions.id))
    .where(eq(driveBackupPages.backupId, backupId));

  const manifest = buildExportManifest(backup, new Date().toISOString(), pageRows);

  return (async function* () {
    const archive = archiver('zip', { store: true });
    const passthrough = new PassThrough();

    archive.pipe(passthrough);
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });

    // Append each page's content directly inside the bounded worker loop so
    // memory usage stays proportional to CONCURRENCY_CAP × max-page-size rather
    // than the entire backup.  archiver.append() is synchronous (enqueues an
    // entry internally), so concurrent calls from workers are safe.
    await withConcurrencyLimit(
      pageRows,
      async row => {
        let content: Buffer;
        if (!row.contentRef) {
          content = Buffer.from('', 'utf-8');
        } else {
          try {
            content = Buffer.from(await readPageContent(row.contentRef), 'utf-8');
          } catch (err) {
            content = Buffer.from(JSON.stringify({ error: (err as Error).message }), 'utf-8');
          }
        }
        archive.append(content, { name: `${row.pageId}.txt` });
      },
      CONCURRENCY_CAP,
    );

    archive.finalize();

    for await (const chunk of passthrough) {
      yield chunk as Buffer;
    }
  })();
}
