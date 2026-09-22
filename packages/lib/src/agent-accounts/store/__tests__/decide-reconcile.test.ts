/**
 * ADR 0005 §2.3, §10.29 — a write whose metadata commit failed is
 * reconcile-required, and the next locked call either commits it forward or
 * fails closed; a first put adopts an orphan only when it is exactly its own
 * attempted write (G1c E1). Written RED before `digest-write.ts`,
 * `decide-reconcile.ts` and `decide-orphan-adoption.ts` exist.
 */
import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { CredentialVersion } from '@pagespace/db/schema/agent-accounts';
import type { HmacBytes, PendingWrite, WriteDigest, WriteDigestKey } from '../store-adapter';
import { digestWrite } from '../digest-write';
import { decideReconcile } from '../decide-reconcile';
import { decideOrphanAdoption } from '../decide-orphan-adoption';

const hmac: HmacBytes = (key, bytes) => createHmac('sha3-256', key).update(bytes).digest('hex');
const key = new Uint8Array(32).fill(9) as WriteDigestKey;
const v = (n: number) => n as CredentialVersion;

describe('decideReconcile (G1c E1)', () => {
  const attempted = digestWrite({ secretValue: 'next', secretComment: 'bindings', key, hmac });
  const pending: PendingWrite = { version: v(5), digest: attempted, rotation: true };

  it('given Infisical at exactly the pending version with exactly the attempted write, should commit forward to that version', () => {
    const actual = decideReconcile({ pending, current: v(4), observed: { version: v(5), digest: attempted } });
    expect(actual).toEqual({ outcome: 'commit_forward', version: 5 });
  });

  // G2 ruling E1(b): Infisical still at the committed version means the replacing write provably
  // did not land (every Infisical write creates a new version), so the marker is aborted and the ref
  // returns to service instead of staying reconcile-required forever.
  it('given Infisical still at the committed version, should abort the pending write whatever digest it shows', () => {
    const other = digestWrite({ secretValue: 'still-the-old-material', secretComment: 'bindings', key, hmac });
    const actual = [
      decideReconcile({ pending, current: v(4), observed: { version: v(4), digest: attempted } }),
      decideReconcile({ pending, current: v(4), observed: { version: v(4), digest: other } }),
    ];
    const expected = [{ outcome: 'abort_pending' }, { outcome: 'abort_pending' }];
    expect(actual).toEqual(expected);
  });

  it('given a version below the committed one, above the pending one, another write at the pending version, or nothing observable, should fail closed', () => {
    const other = digestWrite({ secretValue: 'someone-else', secretComment: 'bindings', key, hmac });
    const actual = [
      decideReconcile({ pending, current: v(4), observed: { version: v(3), digest: attempted } }),
      decideReconcile({ pending, current: v(4), observed: { version: v(6), digest: attempted } }),
      decideReconcile({ pending, current: v(4), observed: { version: v(5), digest: other } }),
      decideReconcile({ pending, current: v(4), observed: null }),
    ];
    expect(actual).toEqual([{ outcome: 'fail_closed' }, { outcome: 'fail_closed' }, { outcome: 'fail_closed' }, { outcome: 'fail_closed' }]);
  });

  it('given digests that differ only in case, should fail closed — a digest compare is exact', () => {
    const actual = decideReconcile({ pending, current: v(4), observed: { version: v(5), digest: attempted.toUpperCase() as WriteDigest } });
    expect(actual).toEqual({ outcome: 'fail_closed' });
  });
});

describe('decideOrphanAdoption (G1c E1)', () => {
  const attempted = digestWrite({ secretValue: 'material', secretComment: 'bindings', key, hmac });

  it('given an orphan that is exactly this attempted write, should adopt it at its version', () => {
    const actual = decideOrphanAdoption({ attempted, observed: { version: v(1), digest: attempted } });
    expect(actual).toEqual({ outcome: 'adopt', version: 1 });
  });

  it('given an orphan holding any other write, should erase it', () => {
    const other = digestWrite({ secretValue: 'older-material', secretComment: 'bindings', key, hmac });
    const actual = decideOrphanAdoption({ attempted, observed: { version: v(1), digest: other } });
    expect(actual).toEqual({ outcome: 'erase' });
  });
});
