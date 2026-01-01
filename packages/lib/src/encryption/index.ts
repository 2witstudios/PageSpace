/**
 * @module @pagespace/lib/encryption
 * @description Encryption and cryptographic utilities
 */

export * from './encryption-utils';

// Explicit re-exports for legacy format detection and migration (used in migration scripts)
export { isLegacyFormat, reEncrypt } from './encryption-utils';
export type { ReEncryptResult } from './encryption-utils';
