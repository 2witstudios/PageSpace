/**
 * Persistence seam for the polymorphic attachment-upload pipeline.
 *
 * Tests mock this module to assert the file row + linkage payloads without
 * touching the ORM chain (per unit-test-rubric §4).
 *
 * @module @pagespace/lib/services/attachment-upload-repository
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { files, filePages, fileConversations } from '@pagespace/db/schema/storage';
import type { AttachmentTarget, FileRecordInput } from './attachment-upload-core';

export type { FileRecordInput };

// The transaction executor type (also satisfied by `db`), so the link helper can
// run on the same transactional client as the file-row insert.
type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

async function linkOnExecutor(
  tx: Executor,
  target: AttachmentTarget,
  fileId: string,
  userId: string,
): Promise<void> {
  switch (target.type) {
    case 'page':
      await tx
        .insert(filePages)
        .values({ fileId, pageId: target.pageId, linkedBy: userId, linkSource: 'channel-upload' })
        .onConflictDoNothing();
      return;

    case 'conversation':
      await tx
        .insert(fileConversations)
        .values({ fileId, conversationId: target.conversationId, linkedBy: userId, linkSource: 'dm-upload' })
        .onConflictDoNothing();
      return;

    default: {
      const _exhaustive: never = target;
      void _exhaustive;
      throw new Error(
        `Unknown attachment target type: ${(target as { type?: unknown }).type}`
      );
    }
  }
}

export interface SaveFileRecordAndLinkInput {
  fileRecord: FileRecordInput;
  target: AttachmentTarget;
  userId: string;
}

/**
 * Persist the content-addressed `files` row AND its target linkage atomically in
 * one transaction, returning whether THIS call inserted the file row (first
 * physical store).
 *
 * Atomicity is the point (M8 retry-safety): if the link insert fails, the file
 * row insert is rolled back too, so a retry re-inserts the row and `inserted`
 * is true again — the single first-store storage charge is never permanently
 * skipped by a transient linkage failure that left an orphaned, uncharged row.
 */
async function saveFileRecordAndLink(input: SaveFileRecordAndLinkInput): Promise<{ inserted: boolean }> {
  const { fileRecord, target, userId } = input;
  return db.transaction(async (tx) => {
    const insertedRows = await tx
      .insert(files)
      .values(fileRecord)
      .onConflictDoNothing()
      .returning({ id: files.id });

    const inserted = insertedRows.length > 0;
    if (!inserted) {
      const existing = await tx.query.files.findFirst({ where: eq(files.id, fileRecord.id) });
      if (!existing) {
        throw new Error('Failed to load existing file metadata');
      }
    }

    await linkOnExecutor(tx, target, fileRecord.id, userId);
    return { inserted };
  });
}

export const attachmentUploadRepository = {
  saveFileRecordAndLink,
};
