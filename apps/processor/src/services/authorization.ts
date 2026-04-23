import { loggers } from '@pagespace/lib/logging/logger-config';
import { getUserAccessLevel, getUserDrivePermissions } from '@pagespace/lib/permissions';
import type { EnforcedAuthContext, ResourceBinding } from '../middleware/auth';
import { getLinksForFile, getFileDriveId, type FileLink } from './file-links';

export type AccessRequirement = 'view' | 'edit';

export type BindingMatchType = 'exact' | 'hierarchical' | 'unbound' | 'mismatch';

export type DenialStage = 'identity' | 'binding' | 'permission' | 'not_found';

export interface AuthorizationDecision {
  allowed: boolean;

  checks: {
    identityVerified: boolean;
    bindingAllowed: boolean;
    permissionGranted: boolean;
  };

  binding: {
    tokenBinding: ResourceBinding | null;
    matchType: BindingMatchType;
  };

  permission?: {
    required: AccessRequirement;
    grantedVia: 'page_permission' | 'drive_permission' | null;
  };

  denial?: {
    stage: DenialStage;
  };

  context?: {
    pageId?: string;
    driveId?: string;
  };
}

export class FileAuthorizationError extends Error {
  constructor(
    message = 'Access denied for requested file',
    public readonly decision?: AuthorizationDecision
  ) {
    super(message);
    this.name = 'FileAuthorizationError';
  }
}

function buildDeniedDecision(
  stage: DenialStage,
  binding: ResourceBinding | null,
  matchType: BindingMatchType,
  requirement: AccessRequirement
): AuthorizationDecision {
  return {
    allowed: false,
    checks: {
      identityVerified: stage !== 'identity',
      bindingAllowed: stage !== 'binding' && stage !== 'identity',
      permissionGranted: false,
    },
    binding: {
      tokenBinding: binding,
      matchType,
    },
    permission: {
      required: requirement,
      grantedVia: null,
    },
    denial: { stage },
  };
}

function buildAllowedDecision(
  binding: ResourceBinding | null,
  matchType: BindingMatchType,
  requirement: AccessRequirement,
  grantedVia: 'page_permission' | 'drive_permission',
  context: { pageId?: string; driveId?: string }
): AuthorizationDecision {
  return {
    allowed: true,
    checks: {
      identityVerified: true,
      bindingAllowed: true,
      permissionGranted: true,
    },
    binding: {
      tokenBinding: binding,
      matchType,
    },
    permission: {
      required: requirement,
      grantedVia,
    },
    context,
  };
}

function determineBindingMatchType(
  binding: ResourceBinding | null,
  contentHash: string,
  links: FileLink[],
  fileDriveId?: string
): BindingMatchType {
  if (!binding) {
    return 'unbound';
  }

  switch (binding.type) {
    case 'file':
      return binding.id.toLowerCase() === contentHash ? 'exact' : 'mismatch';
    case 'page':
      return links.some(link => link.pageId === binding.id) ? 'hierarchical' : 'mismatch';
    case 'drive':
      if (links.some(link => link.driveId === binding.id)) {
        return 'hierarchical';
      }
      // Orphan file case: no links but file belongs to this drive
      if (links.length === 0 && fileDriveId === binding.id) {
        return 'hierarchical';
      }
      return 'mismatch';
    default:
      return 'mismatch';
  }
}

function getScopedLinks(links: FileLink[], binding: ResourceBinding | null): FileLink[] {
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
      /* c8 ignore next */
      return [];
  }
}

async function checkPagePermissions(
  userId: string,
  links: FileLink[],
  requirement: AccessRequirement
): Promise<{ allowed: boolean; pageId?: string; driveId?: string }> {
  for (const link of links) {
    const perms = await getUserAccessLevel(userId, link.pageId);
    if (!perms) {
      continue;
    }

    if (requirement === 'view' && perms.canView) {
      return { allowed: true, pageId: link.pageId, driveId: link.driveId };
    }

    if (requirement === 'edit' && (perms.canEdit || perms.canShare)) {
      return { allowed: true, pageId: link.pageId, driveId: link.driveId };
    }
  }

  return { allowed: false };
}

async function checkDrivePermissions(
  userId: string,
  driveId: string,
  requirement: AccessRequirement
): Promise<boolean> {
  const drivePerms = await getUserDrivePermissions(userId, driveId);
  if (!drivePerms) {
    return false;
  }

  if (requirement === 'view') {
    // Any drive membership grants view access to orphan files
    return true;
  }

  // Edit requires admin/owner for orphan files
  return drivePerms.isOwner || drivePerms.isAdmin;
}

export async function authorizeFileAccess(
  auth: EnforcedAuthContext,
  contentHash: string,
  requirement: AccessRequirement
): Promise<AuthorizationDecision> {
  const binding = auth.resourceBinding ?? null;
  const normalizedHash = contentHash.toLowerCase();

  // Step 1: Verify identity
  if (!auth.userId) {
    const decision = buildDeniedDecision('identity', binding, 'mismatch', requirement);
    loggers.security.warn('file-access denied: missing userId', {
      contentHash: normalizedHash,
      requirement,
      decision,
    });
    return decision;
  }

  // Step 2: Fetch file context
  const [links, fileDriveId] = await Promise.all([
    getLinksForFile(normalizedHash),
    getFileDriveId(normalizedHash),
  ]);

  // Step 3: Check binding
  const matchType = determineBindingMatchType(binding, normalizedHash, links, fileDriveId);

  if (matchType === 'mismatch') {
    const decision = buildDeniedDecision('binding', binding, matchType, requirement);
    loggers.security.warn('file-access denied: resource binding mismatch', {
      userId: auth.userId,
      contentHash: normalizedHash,
      requirement,
      bindingType: binding?.type,
      bindingId: binding?.id,
      linksCount: links.length,
      decision,
    });
    return decision;
  }

  // Step 4: Handle orphan files (no links)
  if (links.length === 0) {
    if (!fileDriveId) {
      const decision = buildDeniedDecision('not_found', binding, matchType, requirement);
      loggers.security.warn('file-access denied: orphan file with no drive', {
        userId: auth.userId,
        contentHash: normalizedHash,
        requirement,
        decision,
      });
      return decision;
    }

    // Check drive permissions for orphan file
    const hasDriveAccess = await checkDrivePermissions(auth.userId, fileDriveId, requirement);

    if (!hasDriveAccess) {
      const decision = buildDeniedDecision('permission', binding, matchType, requirement);
      loggers.security.warn('file-access denied: no drive permission for orphan file', {
        userId: auth.userId,
        contentHash: normalizedHash,
        requirement,
        driveId: fileDriveId,
        decision,
      });
      return decision;
    }

    const decision = buildAllowedDecision(binding, matchType, requirement, 'drive_permission', {
      driveId: fileDriveId,
    });
    loggers.security.info('file-access granted: drive permission for orphan file', {
      userId: auth.userId,
      contentHash: normalizedHash,
      requirement,
      driveId: fileDriveId,
      matchType,
    });
    return decision;
  }

  // Step 5: Scope links and check page permissions
  const scopedLinks = getScopedLinks(links, binding);

  /* c8 ignore next 15 */
  if (scopedLinks.length === 0) {
    // File has links but none within token's scope
    const decision = buildDeniedDecision('binding', binding, matchType, requirement);
    loggers.security.warn('file-access denied: no links within binding scope', {
      userId: auth.userId,
      contentHash: normalizedHash,
      requirement,
      bindingType: binding?.type,
      bindingId: binding?.id,
      totalLinks: links.length,
      scopedLinks: 0,
      decision,
    });
    return decision;
  }

  const pageResult = await checkPagePermissions(auth.userId, scopedLinks, requirement);

  if (!pageResult.allowed) {
    const decision = buildDeniedDecision('permission', binding, matchType, requirement);
    loggers.security.warn('file-access denied: no page permission', {
      userId: auth.userId,
      contentHash: normalizedHash,
      requirement,
      scopedLinksCount: scopedLinks.length,
      decision,
    });
    return decision;
  }

  const decision = buildAllowedDecision(binding, matchType, requirement, 'page_permission', {
    pageId: pageResult.pageId,
    driveId: pageResult.driveId,
  });
  loggers.security.info('file-access granted: page permission', {
    userId: auth.userId,
    contentHash: normalizedHash,
    requirement,
    pageId: pageResult.pageId,
    driveId: pageResult.driveId,
    matchType,
  });
  return decision;
}

export async function assertFileAccess(
  auth: EnforcedAuthContext,
  contentHash: string,
  requirement: AccessRequirement
): Promise<AuthorizationDecision> {
  const decision = await authorizeFileAccess(auth, contentHash, requirement);

  if (!decision.allowed) {
    const action = requirement === 'edit' ? 'modify' : 'view';
    throw new FileAuthorizationError(
      `User ${auth.userId} is not authorized to ${action} file`,
      decision
    );
  }

  return decision;
}
