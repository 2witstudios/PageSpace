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
import type { AttachmentTarget } from './attachment-upload';

export interface FileRecordInput {
  id: string;
  driveId: string | null;
  sizeBytes: number;
  mimeType: string;
  storagePath: string;
  createdBy: string;
}

async function saveFileRecord(input: FileRecordInput): Promise<void> {
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
  }
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
