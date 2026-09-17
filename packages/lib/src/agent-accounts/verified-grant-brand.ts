/**
 * The runtime value of `VerifiedGrant`'s brand (G1c R9). A `unique symbol`,
 * so the type cannot be satisfied by any object literal a caller writes; the
 * only production importer is `verify-grant.ts`, which attaches it to a grant
 * after every check passed. A test pins that import set.
 */
export const VERIFIED_GRANT: unique symbol = Symbol('VerifiedGrant');
