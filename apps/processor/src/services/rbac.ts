import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { channelMessages } from '@pagespace/db/schema/chat';
import { filePages, files } from '@pagespace/db/schema/storage';
import { pages } from '@pagespace/db/schema/core';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { getUserAccessLevel, getUserDrivePermissions } from '@pagespace/lib/permissions/permissions';
import { isFileOrphaned } from '@pagespace/lib/compliance/file-cleanup/orphan-detector';
import { SYSTEM_SERVICE_USER_ID } from '@pagespace/lib/services/validated-service-token';
import type { EnforcedAuthContext } from '../middleware/auth';
import { getLinksForFile, type FileLink } from './file-links';

export class DeleteFileAuthorizationError extends Error {
  constructor(message = 'Access denied for requested file') {
    super(message);
    this.name = 'DeleteFileAuthorizationError';
  }
}

export class DeleteFileReferencedError extends Error {
  constructor(message = 'File is still referenced and cannot be hard deleted') {
    super(message);
    this.name = 'DeleteFileReferencedError';
  }
}

interface DeleteFileContext {
  links: FileLink[];
  fileDriveId?: string;
  hasFilePageReferences: boolean;
  hasChannelReferences: boolean;
  hasPagePathReferences: boolean;
}

function isResourceBindingAllowed(
  auth: EnforcedAuthContext,
  contentHash: string,
  links: FileLink[],
  fileDriveId?: string
): boolean {
  const binding = auth.resourceBinding;
  if (!binding) {
    return true;
  }

  switch (binding.type) {
    case 'file':
      return binding.id === contentHash;
    case 'page':
      return links.some(link => link.pageId === binding.id);
    case 'drive':
      return links.some(link => link.driveId === binding.id) || (links.length === 0 && fileDriveId === binding.id);
    default:
      return false;
  }
}

function getScopedLinks(links: FileLink[], binding: EnforcedAuthContext['resourceBinding']): FileLink[] {
  if (!binding) {
    return links;
  }

  switch (binding.type) {
    case 'page':
      return links.filter(link => link.pageId === binding.id);
    case 'drive':
      return links.filter(link => link.driveId === binding.id);
    case 'file':
      return links;
    /* c8 ignore next 2 -- exhaustive switch, all binding.type values handled above */
    default:
      return [];
  }
}

async function getDeleteFileContext(contentHash: string): Promise<DeleteFileContext> {
  const [links, fileRecord, filePageRef, channelRef, pagePathRef] = await Promise.all([
    getLinksForFile(contentHash),
    db.query.files.findFirst({
      where: eq(files.id, contentHash),
      columns: { driveId: true },
    }),
    db.query.filePages.findFirst({
      where: eq(filePages.fileId, contentHash),
      columns: { fileId: true },
    }),
    db.query.channelMessages.findFirst({
      where: eq(channelMessages.fileId, contentHash),
      columns: { id: true },
    }),
    db.query.pages.findFirst({
      where: eq(pages.filePath, contentHash),
      columns: { id: true },
    }),
  ]);

  return {
    links,
    fileDriveId: fileRecord?.driveId ?? undefined,
    hasFilePageReferences: filePageRef !== undefined,
    hasChannelReferences: channelRef !== undefined,
    hasPagePathReferences: pagePathRef !== undefined,
  };
}

export async function assertDeleteFileAccess(auth: EnforcedAuthContext | undefined, contentHash: string): Promise<void> {
  if (!auth?.userId) {
    throw new DeleteFileAuthorizationError('Service authentication required');
  }

  const normalizedHash = contentHash.toLowerCase();
  const context = await getDeleteFileContext(normalizedHash);

  if (!isResourceBindingAllowed(auth, normalizedHash, context.links, context.fileDriveId)) {
    loggers.security.warn('delete-file denied: resource binding mismatch', {
      userId: auth.userId,
      contentHash: normalizedHash,
      bindingType: auth.resourceBinding?.type,
      bindingId: auth.resourceBinding?.id,
    });
    throw new DeleteFileAuthorizationError();
  }

  if (context.links.length > 0) {
    const scopedLinks = getScopedLinks(context.links, auth.resourceBinding);

    let canDeleteLinkedPage = false;
    for (const link of scopedLinks) {
      const perms = await getUserAccessLevel(auth.userId, link.pageId);
      if (perms?.canDelete) {
        canDeleteLinkedPage = true;
        break;
      }
    }

    if (!canDeleteLinkedPage) {
      loggers.security.warn('delete-file denied: insufficient page delete permission', {
        userId: auth.userId,
        contentHash: normalizedHash,
        scopedLinksCount: scopedLinks.length,
      });
      throw new DeleteFileAuthorizationError();
    }
  } else {
    // Orphan file (no file_pages link). Two trusted callers reach this branch:
    //   1. A drive owner/admin via createDriveServiceToken (drive-bound token).
    //   2. The orphan-reaping cron via createSystemFileDeleteToken — a system,
    //      file-bound token whose binding.id MUST match the contentHash.
    //
    // The system path is the only way to delete a null-driveId orphan (e.g.
    // a DM-only attachment with no conversation linkage left).
    const isSystemFileBoundDelete =
      auth.userId === SYSTEM_SERVICE_USER_ID &&
      auth.resourceBinding?.type === 'file' &&
      auth.resourceBinding.id.toLowerCase() === normalizedHash;

    if (isSystemFileBoundDelete) {
      // Defense-in-depth: getLinksForFile only sees file_pages, so a file
      // re-linked to an active DM, conversation, or channel between the
      // cron's orphan scan and this delete would otherwise sneak through.
      // isFileOrphaned uses the canonical 5-way predicate (file_pages,
      // channel_messages, pages.filePath, file_conversations, and
      // direct_messages with isActive=true) so a TOCTOU race during the
      // cron window cannot reclaim a file that is no longer orphaned.
      const stillOrphaned = await isFileOrphaned(
        db as Parameters<typeof isFileOrphaned>[0],
        normalizedHash,
      );
      if (!stillOrphaned) {
        loggers.security.warn('delete-file denied: file re-linked between scan and delete', {
          contentHash: normalizedHash,
        });
        throw new DeleteFileReferencedError();
      }

      loggers.security.info('delete-file authorized: system file-bound orphan reap', {
        contentHash: normalizedHash,
        fileDriveId: context.fileDriveId ?? null,
      });
    } else if (!context.fileDriveId) {
      loggers.security.warn('delete-file denied: orphan file with no drive association', {
        userId: auth.userId,
        contentHash: normalizedHash,
      });
      throw new DeleteFileAuthorizationError();
    } else {
      const drivePerms = await getUserDrivePermissions(auth.userId, context.fileDriveId);
      if (!drivePerms || (!drivePerms.isOwner && !drivePerms.isAdmin)) {
        loggers.security.warn('delete-file denied: not drive owner/admin for orphan file', {
          userId: auth.userId,
          contentHash: normalizedHash,
          driveId: context.fileDriveId,
          hasAccess: !!drivePerms,
        });
        throw new DeleteFileAuthorizationError();
      }
    }
  }

  if (context.hasFilePageReferences || context.hasChannelReferences || context.hasPagePathReferences) {
    loggers.security.warn('delete-file denied: file still has references', {
      userId: auth.userId,
      contentHash: normalizedHash,
      hasFilePageReferences: context.hasFilePageReferences,
      hasChannelReferences: context.hasChannelReferences,
      hasPagePathReferences: context.hasPagePathReferences,
    });
    throw new DeleteFileReferencedError();
  }
}
