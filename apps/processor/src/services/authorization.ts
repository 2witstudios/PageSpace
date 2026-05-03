import { loggers } from '@pagespace/lib/logging/logger-config';
import { getUserAccessLevel, getUserDrivePermissions } from '@pagespace/lib/permissions/permissions';
import type { EnforcedAuthContext, ResourceBinding } from '../middleware/auth';
import {
  getLinksForFile,
  getConversationLinksForFile,
  getFileDriveId,
  type ConversationFileLink,
  type FileLink,
} from './file-links';

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
    grantedVia: 'page_permission' | 'drive_permission' | 'conversation_participant' | null;
  };

  denial?: {
    stage: DenialStage;
  };

  context?: {
    pageId?: string;
    driveId?: string;
    conversationId?: string;
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
  grantedVia: 'page_permission' | 'drive_permission' | 'conversation_participant',
  context: { pageId?: string; driveId?: string; conversationId?: string }
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
  conversationLinks: ConversationFileLink[],
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
    case 'conversation':
      return conversationLinks.some(link => link.conversationId === binding.id) ? 'hierarchical' : 'mismatch';
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

function getScopedConversationLinks(
  links: ConversationFileLink[],
  binding: ResourceBinding | null
): ConversationFileLink[] {
  if (!binding) {
    return links;
  }

  switch (binding.type) {
    case 'conversation':
      return links.filter(link => link.conversationId === binding.id);
    case 'file':
      return links;
    default:
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

function checkConversationPermissions(
  userId: string,
  links: ConversationFileLink[],
  requirement: AccessRequirement
): { allowed: boolean; conversationId?: string } {
  if (requirement !== 'view') {
    return { allowed: false };
  }

  for (const link of links) {
    if (link.participant1Id === userId || link.participant2Id === userId) {
      return { allowed: true, conversationId: link.conversationId };
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
  const [links, conversationLinks, fileDriveId] = await Promise.all([
    getLinksForFile(normalizedHash),
    getConversationLinksForFile(normalizedHash),
    getFileDriveId(normalizedHash),
  ]);

  // Step 3: Check binding
  const matchType = determineBindingMatchType(
    binding,
    normalizedHash,
    links,
    conversationLinks,
    fileDriveId
  );

  if (matchType === 'mismatch') {
    const decision = buildDeniedDecision('binding', binding, matchType, requirement);
    loggers.security.warn('file-access denied: resource binding mismatch', {
      userId: auth.userId,
      contentHash: normalizedHash,
      requirement,
      bindingType: binding?.type,
      bindingId: binding?.id,
      linksCount: links.length,
      conversationLinksCount: conversationLinks.length,
      decision,
    });
    return decision;
  }

  // Step 4: Check explicit page/conversation linkages before any fallback.
  if (links.length > 0 || conversationLinks.length > 0) {
    const scopedLinks = getScopedLinks(links, binding);
    const scopedConversationLinks = getScopedConversationLinks(conversationLinks, binding);

    if (scopedLinks.length === 0 && scopedConversationLinks.length === 0) {
      const decision = buildDeniedDecision('binding', binding, matchType, requirement);
      loggers.security.warn('file-access denied: no links within binding scope', {
        userId: auth.userId,
        contentHash: normalizedHash,
        requirement,
        bindingType: binding?.type,
        bindingId: binding?.id,
        totalLinks: links.length,
        totalConversationLinks: conversationLinks.length,
        scopedLinks: 0,
        scopedConversationLinks: 0,
        decision,
      });
      return decision;
    }

    const pageResult = await checkPagePermissions(auth.userId, scopedLinks, requirement);

    if (pageResult.allowed) {
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

    const conversationResult = checkConversationPermissions(
      auth.userId,
      scopedConversationLinks,
      requirement
    );

    if (conversationResult.allowed) {
      const decision = buildAllowedDecision(
        binding,
        matchType,
        requirement,
        'conversation_participant',
        { conversationId: conversationResult.conversationId }
      );
      loggers.security.info('file-access granted: conversation participant', {
        userId: auth.userId,
        contentHash: normalizedHash,
        requirement,
        conversationId: conversationResult.conversationId,
        matchType,
      });
      return decision;
    }

    const decision = buildDeniedDecision('permission', binding, matchType, requirement);
    loggers.security.warn('file-access denied: no qualifying linked-resource permission', {
      userId: auth.userId,
      contentHash: normalizedHash,
      requirement,
      scopedLinksCount: scopedLinks.length,
      scopedConversationLinksCount: scopedConversationLinks.length,
      decision,
    });
    return decision;
  }

  // Step 5: Handle orphan files (no links)
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

  const decision = buildDeniedDecision('not_found', binding, matchType, requirement);
  loggers.security.warn('file-access denied: unreachable file authorization state', {
    userId: auth.userId,
    contentHash: normalizedHash,
    requirement,
    linksCount: links.length,
    conversationLinksCount: conversationLinks.length,
    decision,
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
