/**
 * @module @pagespace/lib/encryption
 * @description Encryption and cryptographic utilities
 */

export * from './encryption-utils';

// Explicit re-export for legacy format detection (used in migration scripts)
export { isLegacyFormat } from './encryption-utils';
