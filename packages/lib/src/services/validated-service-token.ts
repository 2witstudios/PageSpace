/**
 * Validated Service Token Creation (P1-T4)
 *
 * Centralizes permission validation before granting service token scopes.
 * Ensures users can only get tokens with scopes they're actually authorized for.
 *
 * @module @pagespace/lib/services/validated-service-token
 */

import { db } from '@pagespace/db/db';
import { eq } from '@pagespace/db/operators';
import { pages } from '@pagespace/db/schema/core';
import { files } from '@pagespace/db/schema/storage';
import { users } from '@pagespace/db/schema/auth';
import {
  getUserAccessLevel,
  getUserDrivePermissions,
} from '../permissions/permissions';
import { canUserAccessFile } from '../permissions/file-access';
import { prepareUserWrite } from '../auth/user-repository';
import { sessionService } from '../auth/session-service';
import { MACHINE_CREDENTIAL_AUTHENTICATION } from '../auth/authentication-evidence';
import { loggers } from '../logging/logger-config';
import { requireOrgRole } from '../organizations/authorize';
import { type AccessActor, derivedCredentialEvidence } from '../permissions/access-actor';

/**
 * Service scope types - defines allowed permission scopes
 */
export type ServiceScope =
  | '*'
  | 'files:read'
  | 'files:write'
  | 'files:link'
  | 'files:delete'
  | 'files:optimize'
  | 'files:ingest'
  | 'files:write:any'
  | 'avatars:write'
  | 'avatars:write:any'
  // ORG-1: replace or remove an org's avatar; only on an org-bound token, minted for an org Owner or Admin.
  | 'org-avatars:write'
  | 'queue:read'
  | 'erasure:enqueue'
  | 'broadcast:enqueue'
  | 'app-hosting:publish';

// Duration bounds for service tokens
const DEFAULT_EXPIRY_MS = 5 * 60 * 1000;        // 5 minutes default
const MIN_EXPIRY_MS = 10 * 1000;                 // 10 seconds minimum
const MAX_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days maximum

/**
 * Convert duration string to milliseconds with bounds validation.
 *
 * Validation rules:
 * - Invalid format returns default (5m)
 * - Zero or negative values return default
 * - Values below 10s are floored to 10s
 * - Values exceeding 30 days are capped at 30 days
 */
function durationToMs(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) {
    loggers.api.warn('Invalid duration format, using default', { duration, default: DEFAULT_EXPIRY_MS });
    return DEFAULT_EXPIRY_MS;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  // Reject zero/negative values
  if (value <= 0) {
    loggers.api.warn('Invalid duration value (must be positive), using default', { duration, value, default: DEFAULT_EXPIRY_MS });
    return DEFAULT_EXPIRY_MS;
  }

  let ms: number;
  switch (unit) {
    case 's': ms = value * 1000; break;
    case 'm': ms = value * 60 * 1000; break;
    case 'h': ms = value * 60 * 60 * 1000; break;
    case 'd': ms = value * 24 * 60 * 60 * 1000; break;
    default: return DEFAULT_EXPIRY_MS;
  }

  // Enforce minimum (prevent near-instant expiry)
  if (ms < MIN_EXPIRY_MS) {
    loggers.api.warn('Duration below minimum, using minimum', { duration, ms, min: MIN_EXPIRY_MS });
    return MIN_EXPIRY_MS;
  }

  // Cap at maximum (prevent near-permanent tokens)
  if (ms > MAX_EXPIRY_MS) {
    loggers.api.warn('Duration exceeds maximum, capping', { duration, ms, max: MAX_EXPIRY_MS });
    return MAX_EXPIRY_MS;
  }

  return ms;
}

/**
 * Error thrown when permission is denied for token creation.
 * Callers should return 403 for this error type only.
 */
export class PermissionDeniedError extends Error {
  readonly code = 'PERMISSION_DENIED' as const;

  constructor(message: string) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * Type guard for PermissionDeniedError.
 * Fully realm-independent: avoids instanceof checks that fail across bundles/realms.
 */
export function isPermissionDeniedError(
  error: unknown
): error is PermissionDeniedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'PERMISSION_DENIED' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

export type ResourceType = 'page' | 'drive' | 'user' | 'organization';

/**
 * Permission set representing what a user can do with a resource
 */
export interface PermissionSet {
  canView: boolean;
  canEdit: boolean;
  canDelete: boolean;
  isOwner: boolean;
  /** An org Owner or Admin, on an 'organization' resource only. */
  isOrgAdmin?: boolean;
}

/**
 * Options for creating a validated service token
 */
export interface ValidatedTokenOptions {
  /** Who is requesting the token: their access decides the scopes, and the token carries their ceremony evidence. */
  actor: AccessActor;
  /** Type of resource being accessed */
  resourceType: ResourceType;
  /** ID of the resource (pageId, driveId, or userId for 'user' type) */
  resourceId: string;
  /** Scopes being requested */
  requestedScopes: ServiceScope[];
  /** Drive ID for drive-scoped tokens (required for processor validation) */
  driveId?: string;
  /** Token expiration (jose duration string, default '5m') */
  expiresIn?: string;
}

/**
 * Result of a validated token creation
 */
export interface ValidatedTokenResult {
  /** The opaque session token */
  token: string;
  /** Scopes that were actually granted (may be subset of requested) */
  grantedScopes: ServiceScope[];
}

/**
 * Create a service token with permission-validated scopes.
 *
 * This function:
 * 1. Checks user's actual permissions for the resource
 * 2. Filters requested scopes to only those the user is authorized for
 * 3. Logs the scope grant for audit
 * 4. Returns the token with granted scopes
 *
 * @throws Error if user has no access to the resource
 * @throws Error if user lacks permissions for all requested scopes
 */
export async function createValidatedServiceToken(
  options: ValidatedTokenOptions
): Promise<ValidatedTokenResult> {
  const {
    actor,
    resourceType,
    resourceId,
    requestedScopes,
    expiresIn = '5m',
  } = options;
  const { userId } = actor;

  // Get user's actual permissions for this resource
  const permissions = await getPermissionsForResource(actor, resourceType, resourceId);

  if (!permissions) {
    loggers.api.warn('Service token denied: no access to resource', {
      userId,
      resourceType,
      resourceId,
      requestedScopes,
    });
    throw new Error(`User has no access to ${resourceType}:${resourceId}`);
  }

  // Filter to only scopes user is authorized for
  const grantedScopes = filterScopesByPermissions(requestedScopes, permissions);

  if (grantedScopes.length === 0) {
    loggers.api.warn('Service token denied: no authorized scopes', {
      userId,
      resourceType,
      resourceId,
      requestedScopes,
      permissions,
    });
    throw new Error(`User lacks permissions for requested scopes: ${requestedScopes.join(', ')}`);
  }

  // Log scope grant for audit
  loggers.api.info('Service token scope grant', {
    userId,
    resourceType,
    resourceId,
    requested: requestedScopes,
    granted: grantedScopes,
    filtered: requestedScopes.length !== grantedScopes.length,
  });

  const token = await sessionService.createSession({
    userId,
    type: 'service',
    // The processor re-checks access with this token, so it carries the minting credential's evidence (SEC-2/3).
    authentication: derivedCredentialEvidence(actor),
    scopes: grantedScopes as string[],
    resourceType,
    resourceId,
    driveId: options.driveId,
    expiresInMs: durationToMs(expiresIn),
    createdByService: 'web',
  });

  return {
    token,
    grantedScopes,
  };
}

/**
 * Get user's permissions for a specific resource
 */
async function getPermissionsForResource(
  actor: AccessActor,
  resourceType: ResourceType,
  resourceId: string
): Promise<PermissionSet | null> {
  const { userId } = actor;
  switch (resourceType) {
    case 'page': {
      // Get full permission set for the page
      const perms = await getUserAccessLevel(actor, resourceId);
      if (!perms) {
        return null;
      }
      return {
        canView: perms.canView,
        canEdit: perms.canEdit,
        canDelete: perms.canDelete,
        isOwner: perms.canDelete && perms.canShare, // Owners and admins both have delete+share
      };
    }

    case 'drive': {
      // Get granular drive permissions (excludes page-level collaborators)
      const drivePerms = await getUserDrivePermissions(actor, resourceId);
      if (!drivePerms) {
        // Page collaborators must use page-scoped tokens instead
        return null;
      }
      return {
        canView: true,
        canEdit: drivePerms.canEdit, // Only owners/admins/editors
        canDelete: drivePerms.isOwner || drivePerms.isAdmin,
        isOwner: drivePerms.isOwner,
      };
    }

    case 'user': {
      // Users can only access their own resources (avatars, etc.)
      if (userId !== resourceId) {
        return null;
      }
      return {
        canView: true,
        canEdit: true,
        canDelete: true,
        isOwner: true,
      };
    }

    case 'organization': {
      // ORG-5: the one org authorization function. An org-bound token grants org-scoped writes only
      // (org-avatars:write): no page, drive, user or wildcard power rides on it.
      const authorization = await requireOrgRole(userId, resourceId, 'ADMIN');
      if (!authorization.ok) return null;
      return { canView: false, canEdit: false, canDelete: false, isOwner: false, isOrgAdmin: true };
    }

    default:
      return null;
  }
}

/**
 * Filter requested scopes to only those the user has permissions for
 */
function filterScopesByPermissions(
  requested: ServiceScope[],
  permissions: PermissionSet
): ServiceScope[] {
  return requested.filter((scope) => {
    switch (scope) {
      // Read scopes require view permission
      case 'files:read':
      case 'queue:read':
        return permissions.canView;

      // Write scopes require edit permission
      case 'files:write':
      case 'files:link':
      case 'files:optimize':
      case 'files:ingest':
      case 'avatars:write':
        return permissions.canEdit;

      case 'org-avatars:write':
        return permissions.isOrgAdmin === true;

      // Delete scopes require delete permission
      case 'files:delete':
        return permissions.canDelete;

      // Admin/owner scopes require owner status
      case '*':
      case 'files:write:any':
      case 'avatars:write:any':
        return permissions.isOwner;

      // Erasure enqueue is minted against the caller's own user resource (the
      // self-service subject, or an admin acting through an admin-gated route).
      // The security boundary is the web route that mints it; the processor
      // endpoint is internal-only.
      case 'erasure:enqueue':
        return permissions.isOwner;

      // Broadcast enqueue is minted by the admin console against the admin's own
      // user resource, same shape as erasure:enqueue: the admin-gated route that
      // mints it is the security boundary; the processor endpoint is internal-only.
      case 'broadcast:enqueue':
        return permissions.isOwner;

      // Publish-build enqueue is minted against the caller's own user resource,
      // same shape as erasure:enqueue/broadcast:enqueue: the web route that
      // mints it already verified the caller is a drive OWNER/ADMIN for the
      // env being published (see `.../envs/[envId]/app/route.ts`'s POST); this
      // is the security boundary, and the processor endpoint independently
      // re-verifies `publishedAppId` exists (see `app-build.ts`'s own
      // docblock on why authorization here is scope-only, not resource-bound).
      case 'app-hosting:publish':
        return permissions.isOwner;

      default:
        // Unknown scopes are denied
        return false;
    }
  });
}

/**
 * Convenience function for creating a page-scoped service token
 */
export async function createPageServiceToken(
  actor: AccessActor,
  pageId: string,
  scopes: ServiceScope[],
  expiresIn?: string
): Promise<ValidatedTokenResult> {
  return createValidatedServiceToken({
    actor,
    resourceType: 'page',
    resourceId: pageId,
    requestedScopes: scopes,
    expiresIn,
  });
}

/**
 * Convenience function for creating a drive-scoped service token
 */
export async function createDriveServiceToken(
  actor: AccessActor,
  driveId: string,
  scopes: ServiceScope[],
  expiresIn?: string
): Promise<ValidatedTokenResult> {
  return createValidatedServiceToken({
    actor,
    resourceType: 'drive',
    resourceId: driveId,
    driveId, // Pass driveId as claim for processor validation
    requestedScopes: scopes,
    expiresIn,
  });
}

/**
 * Convenience function for creating a user-scoped service token (e.g., avatars)
 */
export async function createUserServiceToken(
  actor: AccessActor,
  scopes: ServiceScope[],
  expiresIn?: string
): Promise<ValidatedTokenResult> {
  return createValidatedServiceToken({
    actor,
    resourceType: 'user',
    resourceId: actor.userId,
    requestedScopes: scopes,
    expiresIn,
  });
}

/**
 * Convenience function for creating an org-bound service token (the org avatar upload): granted
 * only to the org's Owner and Admins, and bound to that org.
 */
export async function createOrgServiceToken(
  actor: AccessActor,
  orgId: string,
  scopes: ServiceScope[],
  expiresIn?: string
): Promise<ValidatedTokenResult> {
  return createValidatedServiceToken({
    actor,
    resourceType: 'organization',
    resourceId: orgId,
    requestedScopes: scopes,
    expiresIn,
  });
}

/**
 * Convenience function for creating a file-scoped read token.
 *
 * This is used for files whose authorization is not drive-bound, such as DM
 * attachments. The token is still bound to the exact content hash, and scope
 * grants are filtered through canUserAccessFile before the service session is
 * minted.
 */
export async function createFileServiceToken(
  actor: AccessActor,
  fileId: string,
  scopes: ServiceScope[],
  expiresIn?: string
): Promise<ValidatedTokenResult> {
  const { userId } = actor;
  const file = await db.query.files.findFirst({
    where: eq(files.id, fileId),
    columns: { driveId: true, storagePath: true },
  });

  if (!file) {
    loggers.api.warn('File service token denied: file not found', {
      userId,
      fileId,
      requestedScopes: scopes,
    });
    throw new Error(`User has no access to file:${fileId}`);
  }

  const hasAccess = await canUserAccessFile(actor, fileId, file.driveId);
  if (!hasAccess) {
    loggers.api.warn('File service token denied: no access to file', {
      userId,
      fileId,
      requestedScopes: scopes,
    });
    throw new Error(`User has no access to file:${fileId}`);
  }

  const permissions: PermissionSet = {
    canView: true,
    canEdit: false,
    canDelete: false,
    isOwner: false,
  };
  const grantedScopes = filterScopesByPermissions(scopes, permissions);

  if (grantedScopes.length === 0) {
    loggers.api.warn('File service token denied: no authorized scopes', {
      userId,
      fileId,
      requestedScopes: scopes,
    });
    throw new Error(`User lacks permissions for requested scopes: ${scopes.join(', ')}`);
  }

  const contentHash = file.storagePath || fileId;

  loggers.api.info('File service token scope grant', {
    userId,
    fileId,
    contentHash,
    requested: scopes,
    granted: grantedScopes,
    filtered: scopes.length !== grantedScopes.length,
  });

  const token = await sessionService.createSession({
    userId,
    type: 'service',
    authentication: derivedCredentialEvidence(actor),
    scopes: grantedScopes as string[],
    resourceType: 'file',
    resourceId: contentHash,
    expiresInMs: durationToMs(expiresIn ?? '5m'),
    createdByService: 'web',
  });

  return {
    token,
    grantedScopes,
  };
}

/**
 * Scopes granted for file upload operations.
 *
 * `files:ingest` is required by the processor's `/api/ingest` mount — the
 * post-upload enqueue (`/api/upload/complete` → `/api/ingest/pull/{pageId}`)
 * is rejected 403 without it, silently skipping thumbnails/OCR/extraction.
 */
const UPLOAD_SCOPES: ServiceScope[] = ['files:write', 'files:ingest'];

/**
 * Options for creating an upload service token
 */
export interface UploadTokenOptions {
  /** Who is uploading: their access decides, and the token carries their ceremony evidence. */
  actor: AccessActor;
  /** Drive where the file will be uploaded */
  driveId: string;
  /** New page ID being created for the upload */
  pageId: string;
  /** Parent page ID (if uploading to a folder) */
  parentId?: string;
  /** Token expiration (default '10m') */
  expiresIn?: string;
  /**
   * Scopes to grant (default {@link UPLOAD_SCOPES}). All requested scopes are
   * gated behind the same canEdit check; callers that never enqueue ingestion
   * (e.g. channel attachments) should narrow to ['files:write'].
   */
  scopes?: ServiceScope[];
}

/**
 * Create a service token for file uploads with proper permission validation.
 *
 * This function handles the upload-specific case where:
 * - The page being created doesn't exist yet
 * - Permission is checked against either the parent page OR the drive
 * - Token resource is the NEW pageId (for processor file association)
 *
 * @throws PermissionDeniedError if user lacks upload permission or drive mismatch
 */
export async function createUploadServiceToken(
  options: UploadTokenOptions
): Promise<ValidatedTokenResult> {
  const { actor, driveId, pageId, parentId, expiresIn = '10m', scopes = UPLOAD_SCOPES } = options;
  const { userId } = actor;

  let hasPermission = false;
  let permissionSource: 'parent_page' | 'drive';

  if (parentId) {
    // SECURITY: Verify parent page exists and belongs to the claimed drive
    const parentPage = await db.query.pages.findFirst({
      where: eq(pages.id, parentId),
      columns: { driveId: true },
    });

    if (!parentPage) {
      loggers.api.warn('Upload token denied: parent page not found', {
        userId,
        driveId,
        pageId,
        parentId,
      });
      throw new PermissionDeniedError('Permission denied');
    }

    if (parentPage.driveId !== driveId) {
      loggers.api.warn('Upload token denied: parent page drive mismatch', {
        userId,
        claimedDriveId: driveId,
        actualDriveId: parentPage.driveId,
        parentId,
      });
      throw new PermissionDeniedError('Permission denied');
    }

    // Check parent page edit permission
    const pagePerms = await getUserAccessLevel(actor, parentId);
    hasPermission = pagePerms?.canEdit ?? false;
    permissionSource = 'parent_page';
  } else {
    // Uploading to drive root - check drive membership
    const drivePerms = await getUserDrivePermissions(actor, driveId);
    hasPermission = drivePerms?.canEdit ?? false;
    permissionSource = 'drive';
  }

  if (!hasPermission) {
    loggers.api.warn('Upload token denied: no permission', {
      userId,
      driveId,
      pageId,
      parentId,
      permissionSource,
    });
    throw new PermissionDeniedError('Permission denied');
  }

  // Log scope grant for audit
  loggers.api.info('Upload token scope grant', {
    userId,
    driveId,
    pageId,
    parentId,
    permissionSource,
    scopes,
  });

  const token = await sessionService.createSession({
    userId,
    type: 'service',
    authentication: derivedCredentialEvidence(actor),
    scopes: scopes as string[],
    resourceType: 'page',
    resourceId: pageId,
    driveId,
    expiresInMs: durationToMs(expiresIn),
    createdByService: 'web',
  });

  return {
    token,
    grantedScopes: scopes,
  };
}

/** Scopes granted for system orphan-reaping operations */
const SYSTEM_FILE_DELETE_SCOPES: ServiceScope[] = ['files:delete'];

/** Identity used to mint server-only system tokens (not a real user). */
export const SYSTEM_SERVICE_USER_ID = 'system' as const;

/**
 * Bootstrap the system principal user row that backs system-minted service
 * tokens. The sessions table FKs userId → users.id, so the row must exist
 * before any session is inserted. The email uses the RFC 2606 reserved
 * `.invalid` TLD so it can never be delivered to or registered through any
 * external auth flow. This user has no passkeys, no OAuth IDs, and no magic
 * link path, so even though the row exists nobody can authenticate as it.
 *
 * Idempotent on every call (ON CONFLICT DO NOTHING is a sub-millisecond
 * no-op when the row exists). Not cached at module scope so the bootstrap
 * always re-runs in-process — keeps the truth source in PostgreSQL rather
 * than in-memory state that could disagree with the DB across deploys.
 */
async function ensureSystemPrincipal(): Promise<void> {
  const systemUser: typeof users.$inferInsert = {
    id: SYSTEM_SERVICE_USER_ID,
    name: 'System',
    email: 'system@pagespace.invalid',
    provider: 'email',
    tokenVersion: 0,
    role: 'user',
    adminRoleVersion: 0,
    subscriptionTier: 'free',
  };
  await db
    .insert(users)
    .values(await prepareUserWrite(systemUser))
    .onConflictDoNothing();
}

export interface SystemFileDeleteOptions {
  /** Content hash of the orphaned blob to reap. */
  contentHash: string;
  /** Token expiration (default '30s'). */
  expiresIn?: string;
}

/**
 * Create a system file-bound delete token for orphan reaping.
 *
 * This token shape exists for the cleanup-orphaned-files cron, which reclaims
 * files with no live linkages (drive-attached, DM-only, or otherwise). The
 * token is bound to the specific contentHash so it cannot be repurposed to
 * delete a different file.
 *
 * SECURITY: The processor's delete handler enforces a defense-in-depth re-check
 * (isFileOrphaned across all 5 linkage tables, including isActive=true on DMs)
 * before honoring the token, so a TOCTOU race between the cron's orphan scan
 * and the processor's delete cannot reclaim a file that was re-linked in the
 * meantime.
 */
export async function createSystemFileDeleteToken(
  options: SystemFileDeleteOptions
): Promise<ValidatedTokenResult> {
  const { contentHash, expiresIn = '30s' } = options;

  await ensureSystemPrincipal();

  loggers.api.info('System file delete token mint', {
    contentHash,
    scopes: SYSTEM_FILE_DELETE_SCOPES,
  });

  const token = await sessionService.createSession({
    authentication: MACHINE_CREDENTIAL_AUTHENTICATION,
    userId: SYSTEM_SERVICE_USER_ID,
    type: 'service',
    scopes: SYSTEM_FILE_DELETE_SCOPES as string[],
    resourceType: 'file',
    resourceId: contentHash,
    expiresInMs: durationToMs(expiresIn),
    createdByService: 'web',
  });

  return {
    token,
    grantedScopes: SYSTEM_FILE_DELETE_SCOPES,
  };
}
