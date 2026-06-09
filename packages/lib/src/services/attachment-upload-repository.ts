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

/**
 * Persist the content-addressed `files` row. Returns whether THIS call inserted
 * the row (first physical store) so the caller can charge storage exactly once
 * per blob (M8) instead of on every dedup completion.
 */
async function saveFileRecord(input: FileRecordInput): Promise<{ inserted: boolean }> {
  const inserted = await db
    .insert(files)
    .values(input)
    .onConflictDoNothing()
    .returning();

  if (inserted.length === 0) {
    const existing = await db.query.files.findFirst({
      where: eq(files.id, input.id),
    });
    if (!existing) {
      throw new Error('Failed to load existing file metadata');
    }
    return { inserted: false };
  }
  return { inserted: true };
}

export interface LinkFileToTargetInput {
  target: AttachmentTarget;
  fileId: string;
  userId: string;
}

async function linkFileToTarget(input: LinkFileToTargetInput): Promise<void> {
  const { target, fileId, userId } = input;

  switch (target.type) {
    case 'page':
      await db
        .insert(filePages)
        .values({
          fileId,
          pageId: target.pageId,
          linkedBy: userId,
          linkSource: 'channel-upload',
        })
        .onConflictDoNothing();
      return;

    case 'conversation':
      await db
        .insert(fileConversations)
        .values({
          fileId,
          conversationId: target.conversationId,
          linkedBy: userId,
          linkSource: 'dm-upload',
        })
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

export const attachmentUploadRepository = {
  saveFileRecord,
  linkFileToTarget,
};
