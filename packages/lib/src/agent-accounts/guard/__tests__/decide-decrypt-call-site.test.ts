/**
 * L3·G3 — `decideDecryptCallSite`: whether one import edge in the source graph
 * reaches a credential decryptor from a place allowed to hold plaintext
 * (ADR 0005 §10.14; threat model Λ2). The repo-wide guard test feeds every
 * import edge through this function; a new direct `decryptCredentials` import
 * outside the plane — or a raw `decrypt` in an integration path — is
 * `forbidden` and the build goes red.
 */
import { describe, expect, it } from 'vitest';
import { decideDecryptCallSite, type AllowedDecryptSite, type DecryptorSpec } from '../decide-decrypt-call-site';

const CREDENTIALS = 'packages/lib/src/integrations/credentials/encrypt-credentials';
const UTILS = 'packages/lib/src/encryption/encryption-utils';

const decryptors: readonly DecryptorSpec[] = [
  { module: CREDENTIALS, names: ['decryptCredentials'], appliesUnder: null },
  { module: UTILS, names: ['decrypt'], appliesUnder: ['packages/lib/src/integrations/', 'apps/web/src/app/api/integrations/'] },
];

const allowed: readonly AllowedDecryptSite[] = [
  { importer: 'packages/lib/src/agent-accounts/migration/', reason: 'migration' },
  { importer: 'packages/lib/src/services/sandbox/github-token.ts', reason: 'legacy_pending_migration' },
];

const contained: readonly string[] = ['packages/lib/src/agent-accounts/migration/'];

describe('decideDecryptCallSite', () => {
  it('given decryptCredentials imported by a file outside the allowlist, should forbid it', () => {
    const actual = decideDecryptCallSite({ edge: { importer: 'apps/web/src/app/api/new-route/route.ts', module: CREDENTIALS, names: ['decryptCredentials'], reexport: false }, decryptors, allowed, contained });
    const expected = { verdict: 'forbidden', names: ['decryptCredentials'] };
    expect(actual).toEqual(expected);
  });

  it('given decryptCredentials imported by an allowlisted file, should allow it and say why', () => {
    const actual = decideDecryptCallSite({ edge: { importer: 'packages/lib/src/services/sandbox/github-token.ts', module: CREDENTIALS, names: ['decryptCredentials'], reexport: false }, decryptors, allowed, contained });
    const expected = { verdict: 'allowed', reason: 'legacy_pending_migration' };
    expect(actual).toEqual(expected);
  });

  it('given a file inside an allowlisted directory, should allow it', () => {
    const actual = decideDecryptCallSite({ edge: { importer: 'packages/lib/src/agent-accounts/migration/backfill-worker.ts', module: CREDENTIALS, names: ['decryptCredentials'], reexport: false }, decryptors, allowed, contained });
    const expected = { verdict: 'allowed', reason: 'migration' };
    expect(actual).toEqual(expected);
  });

  it('given a sibling path that merely shares the allowlisted directory name as a prefix, should forbid it', () => {
    const actual = decideDecryptCallSite({ edge: { importer: 'packages/lib/src/agent-accounts/migration-evil.ts', module: CREDENTIALS, names: ['decryptCredentials'], reexport: false }, decryptors, allowed, contained });
    const expected = { verdict: 'forbidden', names: ['decryptCredentials'] };
    expect(actual).toEqual(expected);
  });

  it('given an importer path that is not normalized, should forbid it even when it prefix-matches the allowlist', () => {
    const actual = [
      decideDecryptCallSite({ edge: { importer: 'packages/lib/src/agent-accounts/migration/../../integrations/x.ts', module: CREDENTIALS, names: ['decryptCredentials'], reexport: false }, decryptors, allowed, contained }),
      decideDecryptCallSite({ edge: { importer: '/packages/lib/src/agent-accounts/migration/x.ts', module: CREDENTIALS, names: ['decryptCredentials'], reexport: false }, decryptors, allowed, contained }),
      decideDecryptCallSite({ edge: { importer: 'packages\\lib\\src\\agent-accounts\\migration\\x.ts', module: CREDENTIALS, names: ['decryptCredentials'], reexport: false }, decryptors, allowed, contained }),
    ];
    const expected = [
      { verdict: 'forbidden', names: ['decryptCredentials'] },
      { verdict: 'forbidden', names: ['decryptCredentials'] },
      { verdict: 'forbidden', names: ['decryptCredentials'] },
    ];
    expect(actual).toEqual(expected);
  });

  it('given a raw decrypt imported inside an integration path, should forbid it', () => {
    const actual = decideDecryptCallSite({ edge: { importer: 'apps/web/src/app/api/integrations/zoom/disconnect/route.ts', module: UTILS, names: ['decrypt', 'encrypt'], reexport: false }, decryptors, allowed, contained });
    const expected = { verdict: 'forbidden', names: ['decrypt'] };
    expect(actual).toEqual(expected);
  });

  it('given a raw decrypt imported outside every integration path, should leave it to the PII field-encryption rules', () => {
    const actual = decideDecryptCallSite({ edge: { importer: 'packages/lib/src/encryption/field-crypto.ts', module: UTILS, names: ['decrypt'], reexport: false }, decryptors, allowed, contained });
    const expected = { verdict: 'unrelated' };
    expect(actual).toEqual(expected);
  });

  it('given a namespace or dynamic import of a decryptor module, should treat it as importing every decryptor', () => {
    const actual = decideDecryptCallSite({ edge: { importer: 'apps/web/src/lib/x.ts', module: CREDENTIALS, names: 'all', reexport: false }, decryptors, allowed, contained });
    const expected = { verdict: 'forbidden', names: ['decryptCredentials'] };
    expect(actual).toEqual(expected);
  });

  it('given only the encrypting export or an unrelated module, should be unrelated', () => {
    const actual = [
      decideDecryptCallSite({ edge: { importer: 'apps/web/src/app/api/user/integrations/route.ts', module: CREDENTIALS, names: ['encryptCredentials'], reexport: false }, decryptors, allowed, contained }),
      decideDecryptCallSite({ edge: { importer: 'apps/web/src/app/api/user/integrations/route.ts', module: 'packages/lib/src/logging/logger', names: 'all', reexport: false }, decryptors, allowed, contained }),
    ];
    const expected = [{ verdict: 'unrelated' }, { verdict: 'unrelated' }];
    expect(actual).toEqual(expected);
  });

  it('given an allowlisted file that re-exports a decryptor, should forbid it — a re-export carries the decryptor past the allowlist boundary', () => {
    const actual = decideDecryptCallSite({ edge: { importer: 'packages/lib/src/agent-accounts/migration/index.ts', module: CREDENTIALS, names: ['decryptCredentials'], reexport: true }, decryptors, allowed, contained });
    const expected = { verdict: 'forbidden', names: ['decryptCredentials'] };
    expect(actual).toEqual(expected);
  });

  it('given a file outside the allowlist importing from a contained plane/migration module, should forbid it — a wrapper there could hand plaintext out', () => {
    const actual = [
      decideDecryptCallSite({ edge: { importer: 'apps/web/src/app/api/x/route.ts', module: 'packages/lib/src/agent-accounts/migration/read-legacy', names: ['readLegacy'], reexport: false }, decryptors, allowed, contained }),
      decideDecryptCallSite({ edge: { importer: 'apps/web/src/app/api/x/route.ts', module: 'packages/lib/src/agent-accounts/migration/read-legacy', names: 'all', reexport: false }, decryptors, allowed, contained }),
    ];
    const expected = [
      { verdict: 'forbidden', names: ['readLegacy'] },
      { verdict: 'forbidden', names: ['*'] },
    ];
    expect(actual).toEqual(expected);
  });

  it('given an allowlisted file importing from a contained module, should allow it', () => {
    const actual = decideDecryptCallSite({ edge: { importer: 'packages/lib/src/agent-accounts/migration/backfill-worker.ts', module: 'packages/lib/src/agent-accounts/migration/read-legacy', names: ['readLegacy'], reexport: false }, decryptors, allowed, contained });
    const expected = { verdict: 'allowed', reason: 'migration' };
    expect(actual).toEqual(expected);
  });
});
