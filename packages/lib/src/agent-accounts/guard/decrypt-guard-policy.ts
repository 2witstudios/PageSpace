/**
 * The decrypt guard's policy data (L3·G3; ADR 0005 §10.14). Read by the
 * repo-wide guard test, which feeds every import edge through
 * `decideDecryptCallSite`.
 *
 * `LEGACY_PENDING_MIGRATION` is a RATCHET: every credential read that G3 has
 * not yet moved behind the plane is listed by exact file, and the guard fails
 * when an entry no longer imports a decryptor, so moving a path forces its
 * entry out. Entries are removed, never added — a new call site is exactly
 * what the guard exists to refuse. Until the list is empty the Λ2 claim is
 * scoped (threat model §9).
 */
import type { AllowedDecryptSite, DecryptorSpec } from './decide-decrypt-call-site';

/** Where a raw `decrypt` of `ENCRYPTION_KEY` ciphertext is a credential read, not a PII field read. */
const CREDENTIAL_PATHS: readonly string[] = [
  'packages/lib/src/integrations/',
  'packages/lib/src/services/sandbox/',
  'packages/lib/src/compliance/erasure/',
  'packages/lib/src/agent-accounts/',
  'apps/web/src/app/api/integrations/',
  'apps/web/src/app/api/user/integrations/',
  'apps/web/src/app/api/drives/[driveId]/integrations/',
  'apps/web/src/app/api/calendar/',
  'apps/web/src/app/api/cron/',
  'apps/web/src/lib/integrations/',
  'apps/web/src/lib/ai/core/',
];

export const DECRYPTORS: readonly DecryptorSpec[] = [
  { module: 'packages/lib/src/integrations/credentials/encrypt-credentials', names: ['decryptCredentials'], appliesUnder: null },
  { module: 'packages/lib/src/encryption/encryption-utils', names: ['decrypt'], appliesUnder: CREDENTIAL_PATHS },
  { module: 'packages/lib/src/encryption/field-crypto', names: ['decryptField', 'decryptFieldValuesOnce'], appliesUnder: CREDENTIAL_PATHS },
];

/** Call sites G3 has not moved behind the plane yet. Remove an entry when its path moves; never add one. */
export const LEGACY_PENDING_MIGRATION: readonly string[] = [
  'packages/lib/src/integrations/saga/execute-tool.ts',
  'packages/lib/src/services/sandbox/github-token.ts',
  'packages/lib/src/compliance/erasure/revoke-integration-tokens.ts',
  'apps/web/src/app/api/integrations/google-calendar/disconnect/route.ts',
  'apps/web/src/app/api/integrations/zoom/disconnect/route.ts',
  'apps/web/src/lib/integrations/google-calendar/token-refresh.ts',
  'apps/web/src/lib/integrations/zoom/token-refresh.ts',
];

export const ALLOWED_DECRYPT_SITES: readonly AllowedDecryptSite[] = [
  /** The legacy codec itself: after G3 it exists only to read rows the backfill moves. */
  { importer: 'packages/lib/src/integrations/credentials/encrypt-credentials.ts', reason: 'migration' },
  { importer: 'packages/lib/src/agent-accounts/migration/', reason: 'migration' },
  ...LEGACY_PENDING_MIGRATION.map((importer): AllowedDecryptSite => ({ importer, reason: 'legacy_pending_migration' })),
];

/**
 * Plane/migration modules that may be imported only from the allowlist: a
 * wrapper inside one (`readLegacy = (c) => decryptCredentials(c)`) would hand
 * plaintext to its importer without that importer naming a decryptor.
 */
export const CONTAINED_MODULES: readonly string[] = ['packages/lib/src/agent-accounts/migration/'];
