/**
 * ADR 0005 §2.3, §10.29 — a write whose metadata commit failed is
 * reconcile-required, and the next locked call either commits it forward or
 * fails closed; a first put adopts an orphan only when it is exactly its own
 * attempted write (G1c E1). Written RED before `digest-write.ts`,
 * `decide-reconcile.ts` and `decide-orphan-adoption.ts` exist.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { CredentialVersion } from '@pagespace/db/schema/agent-accounts';
import type { HashBytes } from '../../grant';
import type { PendingWrite, WriteDigest } from '../store-adapter';
import { canonicalJson } from '../../canonical-json';
import { digestWrite } from '../digest-write';
import { decideReconcile } from '../decide-reconcile';
import { decideOrphanAdoption } from '../decide-orphan-adoption';

const sha3: HashBytes = (bytes) => createHash('sha3-256').update(bytes).digest('hex');
const v = (n: number) => n as CredentialVersion;

describe('digestWrite (G1c E1)', () => {
  it('given a value and comment, should be the injected hash over canonicalJson of both', () => {
    const actual = digestWrite({ secretValue: '{"kind":"api_key"}', secretComment: '{"tenantId":"t"}', hash: sha3 });
    const expected = sha3(new TextEncoder().encode(canonicalJson({ secretValue: '{"kind":"api_key"}', secretComment: '{"tenantId":"t"}' })));
    expect(actual).toEqual(expected);
  });

  it('given writes that differ only in value, or only in comment, or that swap the two, should digest differently', () => {
    const base = digestWrite({ secretValue: 'a', secretComment: 'b', hash: sha3 });
    const actual = [
      digestWrite({ secretValue: 'a2', secretComment: 'b', hash: sha3 }) === base,
      digestWrite({ secretValue: 'a', secretComment: 'b2', hash: sha3 }) === base,
      digestWrite({ secretValue: 'b', secretComment: 'a', hash: sha3 }) === base,
    ];
    expect(actual).toEqual([false, false, false]);
  });
});

describe('decideReconcile (G1c E1)', () => {
  const attempted = digestWrite({ secretValue: 'next', secretComment: 'bindings', hash: sha3 });
  const pending: PendingWrite = { version: v(5), digest: attempted, rotation: true };

  it('given Infisical at exactly the pending version with exactly the attempted write, should commit forward to that version', () => {
    const actual = decideReconcile({ pending, observed: { version: v(5), digest: attempted } });
    expect(actual).toEqual({ outcome: 'commit_forward', version: 5 });
  });

  it('given another version, another write at the pending version, or nothing observable, should fail closed', () => {
    const other = digestWrite({ secretValue: 'someone-else', secretComment: 'bindings', hash: sha3 });
    const actual = [
      decideReconcile({ pending, observed: { version: v(4), digest: attempted } }),
      decideReconcile({ pending, observed: { version: v(6), digest: attempted } }),
      decideReconcile({ pending, observed: { version: v(5), digest: other } }),
      decideReconcile({ pending, observed: null }),
    ];
    expect(actual).toEqual([{ outcome: 'fail_closed' }, { outcome: 'fail_closed' }, { outcome: 'fail_closed' }, { outcome: 'fail_closed' }]);
  });

  it('given digests that differ only in case, should fail closed — a digest compare is exact', () => {
    const actual = decideReconcile({ pending, observed: { version: v(5), digest: attempted.toUpperCase() as WriteDigest } });
    expect(actual).toEqual({ outcome: 'fail_closed' });
  });
});

describe('decideOrphanAdoption (G1c E1)', () => {
  const attempted = digestWrite({ secretValue: 'material', secretComment: 'bindings', hash: sha3 });

  it('given an orphan that is exactly this attempted write, should adopt it at its version', () => {
    const actual = decideOrphanAdoption({ attempted, observed: { version: v(1), digest: attempted } });
    expect(actual).toEqual({ outcome: 'adopt', version: 1 });
  });

  it('given an orphan holding any other write, should erase it', () => {
    const other = digestWrite({ secretValue: 'older-material', secretComment: 'bindings', hash: sha3 });
    const actual = decideOrphanAdoption({ attempted, observed: { version: v(1), digest: other } });
    expect(actual).toEqual({ outcome: 'erase' });
  });
});
