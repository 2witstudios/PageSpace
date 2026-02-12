import { db, channelMessages, eq, filePages, files, pages } from '@pagespace/db';
import { loggers } from '@pagespace/lib/logger-config';
import { getUserAccessLevel, getUserDrivePermissions } from '@pagespace/lib/permissions-cached';
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
    fileDriveId: fileRecord?.driveId,
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
    if (!context.fileDriveId) {
      loggers.security.warn('delete-file denied: orphan file with no drive association', {
        userId: auth.userId,
        contentHash: normalizedHash,
      });
      throw new DeleteFileAuthorizationError();
    }

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
