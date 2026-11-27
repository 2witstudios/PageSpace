/**
 * Filing a sandbox file into the drive as a FILE page — the production body of
 * `copy_content`'s `new_file_page` destination.
 *
 * It does no new storage work of its own. `createFilePage` (the generalized
 * `createImageFilePage`) owns quota, the content blocklist, the
 * `files`/`pages`/`filePages` insert and the storage charge — the same steps as
 * the upload-complete route. What this adds is the two seams that make the
 * result an UPLOAD rather than a generated image:
 *
 *   - the original is stored THROUGH THE PROCESSOR (`storeOriginalViaProcessor`),
 *     so at-rest encryption applies exactly as it does to every
 *     processor-written original; and
 *   - once committed, the processor's pull-verify job is enqueued
 *     (`enqueueProcessorJob`), so the bytes are re-hashed, Magika-checked and
 *     extracted like an upload, and the page leaves `pending`.
 *
 * The caller has already checked edit access on `parent` (`canActorEditPage`)
 * and capped the bytes at the drive's per-file limit. The upload token minted
 * inside `storeOriginalViaProcessor` re-checks that edit access server-side.
 *
 * Effects are injected so the wiring is testable without a DB or a processor.
 */
import type { AccessActor } from '@pagespace/lib/permissions/access-actor';
import { ContentBlockedError } from '@pagespace/lib/content-safety/policy';
import { validateMimeTypeDeclaration } from '@pagespace/lib/services/upload-validation';
import { PageType } from '@pagespace/lib/utils/enums';
import {
  createFilePage,
  mimeTypeForFileName,
  FileStorageQuotaError,
} from '@/lib/upload/create-file-page';
import { storeOriginalViaProcessor, enqueueProcessorJob } from '@/lib/upload/processor-effects';
import type { CopyPageRecord } from './copy-content-tools';

export interface FileIntoDriveEffects {
  createFilePage: typeof createFilePage;
  storeOriginal: typeof storeOriginalViaProcessor;
  enqueueProcessorJob: typeof enqueueProcessorJob;
  broadcast: (payload: {
    driveId: string;
    pageId: string;
    operation: 'created';
    parentId: string | null;
    title: string;
    type: string;
  }) => Promise<void>;
  /** Compliance activity log, attributed to the person whose turn filed it — as an upload is. */
  logActivity: (args: {
    userId: string;
    pageId: string;
    driveId: string;
    title: string;
    mimeType: string;
    fileSize: number;
    contentHash: string;
  }) => Promise<void>;
  logError: (message: string, error: Error, metadata: Record<string, unknown>) => void;
}

export type FileIntoDriveResult =
  | { success: true; pageId: string; driveId: string; mimeType: string }
  | { success: false; error: string; message: string };

/** Pure: the declared type — the title's extension when it has a known one, else the sandbox path's. */
export function declaredMimeType(title: string, path: string): string {
  const fromTitle = mimeTypeForFileName(title);
  return fromTitle !== 'application/octet-stream' ? fromTitle : mimeTypeForFileName(path);
}

export async function fileSandboxBytesIntoDrive(
  {
    actor,
    parent,
    title,
    path,
    content,
  }: {
    actor: AccessActor;
    parent: CopyPageRecord;
    title: string;
    path: string;
    content: Uint8Array;
  },
  effects: FileIntoDriveEffects,
): Promise<FileIntoDriveResult> {
  const mimeType = declaredMimeType(title, path);
  // Same declaration gate presign applies. The processor's Magika check on the
  // real bytes is still the authority; this refuses the obvious case up front.
  const declared = validateMimeTypeDeclaration(mimeType);
  if (!declared.ok) {
    return { success: false, error: 'File type not allowed', message: `${declared.error.message}; nothing was filed.` };
  }

  const buffer = Buffer.from(content.buffer, content.byteOffset, content.byteLength);
  let created: Awaited<ReturnType<typeof createFilePage>>;
  try {
    created = await effects.createFilePage(
      {
        userId: actor.userId,
        buffer,
        mimeType,
        title,
        source: 'sandbox-copy',
        targetDriveId: parent.driveId,
        targetParentId: parent.id,
      },
      {
        storeOriginal: ({ contentHash, buffer: bytes, title: name, pageId, driveId, parentId }) =>
          effects.storeOriginal({ actor, driveId, parentId, pageId, contentHash, buffer: bytes, originalName: name }),
        afterCommit: async ({ pageId, driveId }) => {
          try {
            await effects.enqueueProcessorJob(actor, driveId, pageId);
          } catch (error) {
            // Best-effort, as in the upload route — but loud: until it is
            // reprocessed the page has no preview and no extracted text.
            effects.logError('copy_content: failed to enqueue processor job', error instanceof Error ? error : new Error(String(error)), {
              userId: actor.userId,
              driveId,
              pageId,
            });
          }
        },
      },
    );
  } catch (error) {
    if (error instanceof FileStorageQuotaError) {
      return { success: false, error: 'Storage limit reached', message: error.message };
    }
    if (error instanceof ContentBlockedError) {
      return { success: false, error: 'Content blocked', message: error.message };
    }
    effects.logError('copy_content: filing a sandbox file failed', error instanceof Error ? error : new Error(String(error)), {
      userId: actor.userId,
      driveId: parent.driveId,
      parentId: parent.id,
    });
    return {
      success: false,
      error: 'Could not file the page',
      message: `Storing ${path} in the drive failed (${error instanceof Error ? error.message : String(error)}). No page was created; retrying is safe.`,
    };
  }

  // Post-commit visibility: never turns a filed page into a failure.
  await effects
    .broadcast({ driveId: created.driveId, pageId: created.pageId, operation: 'created', parentId: created.parentId, title, type: PageType.FILE })
    .catch(() => {});
  await effects
    .logActivity({
      userId: actor.userId,
      pageId: created.pageId,
      driveId: created.driveId,
      title,
      mimeType,
      fileSize: buffer.byteLength,
      contentHash: created.contentHash,
    })
    .catch(() => {});

  return { success: true, pageId: created.pageId, driveId: created.driveId, mimeType };
}
