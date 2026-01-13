/**
 * Validated Service Token Creation (P1-T4)
 *
 * Centralizes permission validation before granting service token scopes.
 * Ensures users can only get tokens with scopes they're actually authorized for.
 *
 * @module @pagespace/lib/services/validated-service-token
 */

import { db, pages, eq } from '@pagespace/db';
import {
  getUserAccessLevel,
  getUserDrivePermissions,
} from '../permissions/permissions-cached';
import { sessionService } from '../auth/session-service';
import { loggers } from '../logging/logger-config';

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
  | 'queue:read';

/**
 * Convert duration string to milliseconds
 */
function durationToMs(duration: string): number {
  const match = duration.match(/^(\d+)([smhd])$/);
  if (!match) return 5 * 60 * 1000; // Default 5 minutes

  const value = parseInt(match[1], 10);
  const unit = match[2];

  switch (unit) {
    case 's': return value * 1000;
    case 'm': return value * 60 * 1000;
    case 'h': return value * 60 * 60 * 1000;
    case 'd': return value * 24 * 60 * 60 * 1000;
    default: return 5 * 60 * 1000;
  }
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

export type ResourceType = 'page' | 'drive' | 'user';

/**
 * Permission set representing what a user can do with a resource
 */
export interface PermissionSet {
  canView: boolean;
  canEdit: boolean;
  canDelete: boolean;
  isOwner: boolean;
}

/**
 * Options for creating a validated service token
 */
export interface ValidatedTokenOptions {
  /** User requesting the token */
  userId: string;
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
  /** Additional context for the token */
  additionalClaims?: Record<string, unknown>;
}

/**
 * Result of a validated token creation
 */
export interface ValidatedTokenResult {
  /** The signed JWT token */
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
    userId,
    resourceType,
    resourceId,
    requestedScopes,
    expiresIn = '5m',
    additionalClaims,
  } = options;

  // Get user's actual permissions for this resource
  const permissions = await getPermissionsForResource(userId, resourceType, resourceId);

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
  userId: string,
  resourceType: ResourceType,
  resourceId: string
): Promise<PermissionSet | null> {
  switch (resourceType) {
    case 'page': {
      // Get full permission set for the page
      const perms = await getUserAccessLevel(userId, resourceId);
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
      const drivePerms = await getUserDrivePermissions(userId, resourceId);
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

      // Delete scopes require delete permission
      case 'files:delete':
        return permissions.canDelete;

      // Admin/owner scopes require owner status
      case '*':
      case 'files:write:any':
      case 'avatars:write:any':
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
  userId: string,
  pageId: string,
  scopes: ServiceScope[],
  expiresIn?: string
): Promise<ValidatedTokenResult> {
  return createValidatedServiceToken({
    userId,
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
  userId: string,
  driveId: string,
  scopes: ServiceScope[],
  expiresIn?: string
): Promise<ValidatedTokenResult> {
  return createValidatedServiceToken({
    userId,
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
  userId: string,
  scopes: ServiceScope[],
  expiresIn?: string
): Promise<ValidatedTokenResult> {
  return createValidatedServiceToken({
    userId,
    resourceType: 'user',
    resourceId: userId,
    requestedScopes: scopes,
    expiresIn,
  });
}

/** Scopes granted for file upload operations */
const UPLOAD_SCOPES: ServiceScope[] = ['files:write'];

/**
 * Options for creating an upload service token
 */
export interface UploadTokenOptions {
  /** User requesting the token */
  userId: string;
  /** Drive where the file will be uploaded */
  driveId: string;
  /** New page ID being created for the upload */
  pageId: string;
  /** Parent page ID (if uploading to a folder) */
  parentId?: string;
  /** Token expiration (default '10m') */
  expiresIn?: string;
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
  const { userId, driveId, pageId, parentId, expiresIn = '10m' } = options;

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
    const pagePerms = await getUserAccessLevel(userId, parentId);
    hasPermission = pagePerms?.canEdit ?? false;
    permissionSource = 'parent_page';
  } else {
    // Uploading to drive root - check drive membership
    const drivePerms = await getUserDrivePermissions(userId, driveId);
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
    scopes: UPLOAD_SCOPES,
  });

  const token = await sessionService.createSession({
    userId,
    type: 'service',
    scopes: UPLOAD_SCOPES as string[],
    resourceType: 'page',
    resourceId: pageId,
    driveId,
    expiresInMs: durationToMs(expiresIn),
    createdByService: 'web',
  });

  return {
    token,
    grantedScopes: UPLOAD_SCOPES,
  };
}
