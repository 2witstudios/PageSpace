/**
 * The shared "can this person run ANYWHERE they can reach?" iteration.
 *
 * Two surfaces ask it — the discovery gate and the pipeline eligibility strip —
 * and the whole reason it is one function is that fixing one without the other
 * changes nothing: the strip removes the tool before the gate can allow it. So
 * the rows below pin the iteration itself, and a source scan pins that neither
 * caller has grown its own copy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { anyReachableEnvironmentPayerAllows } from '../reachable-environment-payers';

/**
 * Derived from the function's own signature rather than imported: the module
 * exports only the function (knip ignores `__tests__`, so an export consumed
 * only here would read as dead code), and deriving it means this fake cannot
 * drift from what the parameter actually takes.
 */
type ReachableEnvironmentPayerDeps = NonNullable<Parameters<typeof anyReachableEnvironmentPayerAllows>[0]['deps']>;

const PRO = { payerId: 'drive-owner', tier: 'pro' as const };

function deps(over: Partial<ReachableEnvironmentPayerDeps> = {}): ReachableEnvironmentPayerDeps {
  return {
    isEnabled: async () => true,
    listEnvironments: async () => [],
    resolvePayer: async () => PRO,
    ...over,
  };
}

describe('anyReachableEnvironmentPayerAllows — asked once per DRIVE', () => {
  it('given TWO machines in ONE drive, should resolve that payer ONCE and still be eligible', async () => {
    const asked: string[] = [];
    const allowed = await anyReachableEnvironmentPayerAllows({
      userId: 'u1',
      authorize: async () => true,
      deps: deps({
        listEnvironments: async () => [{ driveId: 'drive-1' }, { driveId: 'drive-1' }],
        resolvePayer: async (driveId) => {
          asked.push(driveId);
          return PRO;
        },
      }),
    });
    expect(allowed).toBe(true);
    // The dedup cannot change the ANSWER — it is a disjunction over the same
    // set — only how many times it is asked.
    expect(asked).toEqual(['drive-1']);
  });

  it('given machines across TWO drives, should ask twice — the dedup collapses duplicates, never distinct drives', async () => {
    const asked: string[] = [];
    const allowed = await anyReachableEnvironmentPayerAllows({
      userId: 'u1',
      authorize: async () => false,
      deps: deps({
        listEnvironments: async () => [{ driveId: 'drive-1' }, { driveId: 'drive-2' }, { driveId: 'drive-1' }],
        resolvePayer: async (driveId) => {
          asked.push(driveId);
          return PRO;
        },
      }),
    });
    expect(allowed).toBe(false);
    expect(asked).toEqual(['drive-1', 'drive-2']);
  });

  it('given a drive whose payer does NOT resolve, should skip it without refusing the others', async () => {
    // A vanished drive is not an answer about a different one.
    const authorized: string[] = [];
    const allowed = await anyReachableEnvironmentPayerAllows({
      userId: 'u1',
      authorize: async (payer) => {
        authorized.push(payer.payerId);
        return true;
      },
      deps: deps({
        listEnvironments: async () => [{ driveId: 'gone' }, { driveId: 'drive-2' }],
        resolvePayer: async (driveId) => (driveId === 'gone' ? null : PRO),
      }),
    });
    expect(allowed).toBe(true);
    // The vanished drive never reached the authorizer, and did not stop the next.
    expect(authorized).toEqual(['drive-owner']);
  });

  it('stops at the FIRST drive that allows — later drives are not asked', async () => {
    const authorized: string[] = [];
    await anyReachableEnvironmentPayerAllows({
      userId: 'u1',
      authorize: async (payer) => {
        authorized.push(payer.payerId);
        return true;
      },
      deps: deps({
        listEnvironments: async () => [{ driveId: 'drive-1' }, { driveId: 'drive-2' }],
        resolvePayer: async (driveId) => ({ payerId: `owner-of-${driveId}`, tier: 'pro' }),
      }),
    });
    expect(authorized).toEqual(['owner-of-drive-1']);
  });

  it('fails CLOSED on every uncertainty — this only ever WIDENS eligibility', async () => {
    // Asserted by what it does NOT do, not by a throwing authorizer: the
    // fail-closed catch below would swallow that throw and return false anyway,
    // so the assertion would hold with the flag check deleted (it survived the
    // mutant that deleted it). The observable consequence is that nothing is
    // read at all.
    const listed: string[] = [];
    const authorized: string[] = [];
    const flagOff = await anyReachableEnvironmentPayerAllows({
      userId: 'u1',
      authorize: async (payer) => {
        authorized.push(payer.payerId);
        return true;
      },
      deps: deps({
        isEnabled: async () => false,
        listEnvironments: async (userId) => {
          listed.push(userId);
          return [{ driveId: 'drive-1' }];
        },
      }),
    });
    expect(flagOff).toBe(false);
    expect(listed).toEqual([]);
    expect(authorized).toEqual([]);

    const listingThrew = await anyReachableEnvironmentPayerAllows({
      userId: 'u1',
      authorize: async () => true,
      deps: deps({
        listEnvironments: async () => {
          throw new Error('db down');
        },
      }),
    });
    expect(listingThrew).toBe(false);

    const nothingReachable = await anyReachableEnvironmentPayerAllows({
      userId: 'u1',
      authorize: async () => true,
      deps: deps({ listEnvironments: async () => [] }),
    });
    expect(nothingReachable).toBe(false);
  });
});

describe('the two callers share the ITERATION and differ only in the AUTHORIZER', () => {
  const web = join(__dirname, '../../../..');
  const read = (relative: string) => readFileSync(join(web, relative), 'utf8');

  it('neither caller has grown its own copy of the per-drive loop', () => {
    for (const file of ['lib/ai/core/sandbox-tool-eligibility.ts', 'lib/ai/tools/sandbox-tools-runtime.ts']) {
      const source = read(file);
      expect(source, file).toContain('anyReachableEnvironmentPayerAllows');
      // The dedup lives in ONE place; a second copy here is the drift this
      // whole arrangement exists to prevent.
      expect(source, file).not.toMatch(/new Set\([^)]*map\([^)]*driveId/);
    }
  });

  it('they ask with DIFFERENT authorizers on purpose, and each says which', () => {
    // Registration-time vs call-time: the strip asks the same question the rest
    // of its module asks; the gate asks the full call-time gate.
    expect(read('lib/ai/core/sandbox-tool-eligibility.ts')).toContain('canRunCodeForSession');
    expect(read('lib/ai/tools/sandbox-tools-runtime.ts')).toContain('gateSandboxToolCall');
  });
});
