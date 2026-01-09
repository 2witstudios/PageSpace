/**
 * Validated Service Token Creation (P1-T4)
 *
 * Centralizes permission validation before granting service token scopes.
 * Ensures users can only get tokens with scopes they're actually authorized for.
 *
 * @module @pagespace/lib/services/validated-service-token
 */

import {
  getUserAccessLevel,
  canUserViewPage,
  canUserEditPage,
  getUserDriveAccess,
} from '../permissions/permissions-cached';
import { createServiceToken, ServiceScope } from './service-auth';
import { loggers } from '../logging/logger-config';

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

  const token = await createServiceToken({
    service: 'web',
    subject: userId,
    resource: resourceId,
    scopes: grantedScopes,
    expiresIn,
    additionalClaims,
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
        isOwner: perms.canDelete && perms.canShare, // Owners have both delete and share
      };
    }

    case 'drive': {
      // Drive access is simpler - either you have access or you don't
      // For more granular permissions, we'd need to check drive membership role
      const hasAccess = await getUserDriveAccess(userId, resourceId);
      if (!hasAccess) {
        return null;
      }
      // For now, drive access grants view and edit (write files)
      // Delete and owner-level scopes require additional checks
      return {
        canView: true,
        canEdit: true,
        canDelete: false, // Would need role check for this
        isOwner: false, // Would need owner check for this
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
