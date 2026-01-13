import type { SessionClaims } from '../auth/session-service';

export interface ResourceBinding {
  type: string;
  id: string;
}

/**
 * Enforced auth context - MUST be created from validated session.
 * Cannot be constructed directly, only via fromSession().
 * Immutable after creation.
 */
export class EnforcedAuthContext {
  public readonly userId: string;
  public readonly userRole: 'user' | 'admin';
  public readonly resourceBinding?: ResourceBinding;
  public readonly driveId?: string;

  private readonly _scopes: ReadonlySet<string>;

  private constructor(
    userId: string,
    userRole: 'user' | 'admin',
    scopes: string[],
    resourceBinding?: ResourceBinding,
    driveId?: string
  ) {
    this.userId = userId;
    this.userRole = userRole;
    this._scopes = new Set(scopes);
    this.resourceBinding = resourceBinding;
    this.driveId = driveId;

    Object.freeze(this);
  }

  static fromSession(claims: SessionClaims): EnforcedAuthContext {
    const resourceBinding =
      claims.resourceType && claims.resourceId
        ? { type: claims.resourceType, id: claims.resourceId }
        : undefined;

    return new EnforcedAuthContext(
      claims.userId,
      claims.userRole,
      claims.scopes,
      resourceBinding,
      claims.driveId
    );
  }

  hasScope(scope: string): boolean {
    // Global wildcard
    if (this._scopes.has('*')) {
      return true;
    }

    // Exact match
    if (this._scopes.has(scope)) {
      return true;
    }

    // Namespace wildcard (e.g., 'files:*' matches 'files:read')
    const [namespace] = scope.split(':');
    if (namespace && this._scopes.has(`${namespace}:*`)) {
      return true;
    }

    return false;
  }

  isAdmin(): boolean {
    return this.userRole === 'admin';
  }

  isBoundToResource(type: string, id: string): boolean {
    // No binding means unrestricted
    if (!this.resourceBinding) {
      return true;
    }

    return this.resourceBinding.type === type && this.resourceBinding.id === id;
  }
}
