/**
 * @module @pagespace/lib/permissions
 * @description Access control and permissions
 */

export * from './permissions';

export * from './rollback-permissions';

export * from './enforced-context';

export * from './file-access';

// Zero-trust permission mutations (replaces old grantPagePermissions/revokePagePermissions)
export * from './permission-mutations';
export * from './schemas';

// Canonical "what pages can this user view?" primitive backed by the
// accessible_page_ids_for_user Postgres function.
export { accessiblePageIds } from './accessible-page-ids';
