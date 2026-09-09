/**
 * THE FRACTION PRIMITIVES, exercised directly.
 *
 * They had no suite of their own. They were covered through the layout verbs
 * that happened to call them (`workspace-layout-rearrange.test.ts`), so when the
 * old model was deleted the only cases that touched `rebalanceFractions`,
 * `resizeShare`, `currentShares` and the `readFraction` funnel at their own
 * boundary went with it. What remained was indirect coverage through the node
 * algebra — enough to notice a broken resize, not enough to say which of the two
 * broke it.
 *
 * These are the properties the algebra, the validator, the store's read funnel
 * and the backfill all depend on, asserted where they are stated.
 */
import { describe, it, expect } from 'vitest';
import {
  currentShares,
  FRACTION_EPSILON,
  MIN_FRACTION,
  quantizeFraction,
  readFraction,
  rebalanceFractions,
  resizeShare,
} from '../workspace-fractions';

/**
 * THE INVARIANT, as one assertion: a container is either wholly unsized or
 * wholly sized, with every share at or above the floor and the shares summing
 * to 1. The floor relaxes for a container too crowded to honor it — `1/n` is
 * then the even split, which is all anyone can have.
 */
function expectInvariant(shares: Array<number | null>, label = ''): void {
  const sized = shares.filter((share): share is number => share !== null);
  if (sized.length === 0) return;
  expect(sized.length, `${label}: container is MIXED (some sized, some not)`).toBe(shares.length);
  for (const share of sized) {
    expect(Number.isFinite(share), `${label}: non-finite share`).toBe(true);
    expect(share, `${label}: share under the floor`).toBeGreaterThanOrEqual(
      Math.min(MIN_FRACTION, 1 / shares.length) - FRACTION_EPSILON,
    );
  }
  const sum = sized.reduce((total, share) => total + share, 0);
  expect(Math.abs(sum - 1), `${label}: shares sum to ${sum}, not 1`).toBeLessThan(FRACTION_EPSILON);
}

describe('readFraction — THE funnel from an external number to a share', () => {
  it('admits a positive finite number, quantized', () => {
    expect(readFraction(0.25)).toBe(0.25);
    expect(readFraction(0.3333333333)).toBe(0.33333);
  });

  it('reads absent, zero, negative and non-finite as UNSIZED rather than as a share', () => {
    // The wire type is an unbounded `z.number().nullable().optional()`, so all
    // of these pass schema validation. A reader that admitted them with a bare
    // `typeof x === 'number'` would render a 0%-sized member while another
    // reader treated the same row as unsized and split it evenly.
    for (const value of [null, undefined, 0, -0.5, NaN, Infinity, -Infinity]) {
      expect(readFraction(value), `${String(value)}`).toBeNull();
    }
  });
});

describe('quantizeFraction — the float4 storage round trip', () => {
  it('is idempotent, and lands ON the grid rather than one ulp off it', () => {
    // `Math.round(0.75 / 1e-5) * 1e-5` is 0.7500000000000001 — the trailing
    // multiply reintroduces exactly the error the round removed.
    expect(quantizeFraction(0.75)).toBe(0.75);
    expect(quantizeFraction(quantizeFraction(0.6))).toBe(quantizeFraction(0.6));
    expect(quantizeFraction(1 / 3)).toBe(0.33333);
  });

  it('survives a float4 round trip unchanged — what makes a re-send not look like a change', () => {
    const asFloat4 = (value: number) => Math.fround(value);
    for (const value of [0.05, 0.125, 1 / 3, 0.6, 0.95]) {
      const q = quantizeFraction(value);
      expect(quantizeFraction(asFloat4(q)), `${value}`).toBe(q);
    }
  });
});

describe('rebalanceFractions — the one function that establishes the invariant', () => {
  it('leaves an all-unsized container unsized: a membership change writes no shares nobody chose', () => {
    expect(rebalanceFractions([null, null, null])).toEqual([null, null, null]);
  });

  it('calls a LONE member unsized, whatever it arrived carrying', () => {
    // A stored 1.0 states nothing the structure does not, and would make a
    // container that shrank to one look "sized" — so the next insertion would
    // rebalance against a share nobody chose.
    expect(rebalanceFractions([1])).toEqual([null]);
    expect(rebalanceFractions([null])).toEqual([null]);
  });

  it('gives a newcomer an even share and shrinks the survivors proportionally', () => {
    const next = rebalanceFractions([0.6, 0.4, null]);
    expectInvariant(next, 'newcomer');
    expect(next[2]).toBeCloseTo(1 / 3, 5);
    // Survivors keep their 3:2 ratio inside the 2/3 left to them. Compared to
    // 3dp, not more: the shares sit on a 1e-5 grid, so their RATIO carries up
    // to ~6e-5 of quantization error and a tighter assertion would be pinning
    // the rounding rather than the proportion.
    expect(next[0]! / next[1]!).toBeCloseTo(0.6 / 0.4, 3);
  });

  it('rescales survivors to fill what a departure freed', () => {
    const next = rebalanceFractions([0.5, 0.2]);
    expectInvariant(next, 'departure');
    expect(next[0]! / next[1]!).toBeCloseTo(0.5 / 0.2, 3);
  });

  it('reads a MIXED container as unsized wholesale rather than half-trusting it', () => {
    // A subset of fractions summing to less than 1 has no defensible rendering,
    // so the answer is "nobody sized this", not "these two did".
    const next = rebalanceFractions([0.5, null, null]);
    expectInvariant(next, 'mixed');
    expect(next.every((share) => share !== null)).toBe(true);
  });

  it('never puts a member under the floor, even when one sibling arrives enormous', () => {
    const next = rebalanceFractions([0.98, 0.01, 0.01]);
    expectInvariant(next, 'starved siblings');
    for (const share of next) expect(share!).toBeGreaterThanOrEqual(MIN_FRACTION - FRACTION_EPSILON);
  });

  it('degrades to an even split for a container too crowded to honor the floor', () => {
    // 1/MIN_FRACTION is 20 members; 40 cannot all have 0.05.
    const next = rebalanceFractions(Array.from({ length: 40 }, () => null as number | null));
    expect(next.every((share) => share === null)).toBe(true);
    const sized = rebalanceFractions(Array.from({ length: 40 }, (_, index) => (index === 0 ? 0.5 : 0.0128)));
    expectInvariant(sized, 'crowded');
  });

  it('settles the residual onto the LARGEST member, never the last one', () => {
    // Pushing the last member under the floor would break the very invariant
    // the settle exists to close, and the last member can be a small one.
    const next = rebalanceFractions([0.9, 0.05, 0.05]);
    expectInvariant(next, 'residual');
    expect(Math.min(...next.map((share) => share!))).toBeGreaterThanOrEqual(MIN_FRACTION - FRACTION_EPSILON);
  });

  it('answers an empty container with an empty list', () => {
    expect(rebalanceFractions([])).toEqual([]);
  });
});

describe('currentShares — what a container renders at right now', () => {
  it('splits evenly when the container is unsized', () => {
    expect(currentShares([null, null, null, null])).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it('splits evenly when the container is only PARTLY sized', () => {
    // Same rule as `rebalanceFractions`: a mixed container is unsized.
    expect(currentShares([0.7, null])).toEqual([0.5, 0.5]);
  });

  it('returns the stored shares, settled, when the container is sized', () => {
    const shares = currentShares([0.6, 0.4]);
    expect(shares[0]).toBeCloseTo(0.6, 5);
    expect(shares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});

describe('resizeShare — the request is CLAMPED, never refused', () => {
  it('gives the member what it asked for and lets the others absorb it in proportion', () => {
    const next = resizeShare([0.25, 0.5, 0.25], 0, 0.5);
    expectInvariant(next, 'resize');
    expect(next[0]).toBeCloseTo(0.5, 5);
    // The other two keep their 2:1 ratio inside the 0.5 that is left (3dp — see
    // the note on the newcomer case about quantization error in a ratio).
    expect(next[1]! / next[2]!).toBeCloseTo(2, 3);
  });

  it('clamps a request past the ceiling the floor leaves available', () => {
    const next = resizeShare([1 / 3, 1 / 3, 1 / 3], 0, 0.99);
    expectInvariant(next, 'ceiling');
    expect(next[0]).toBeCloseTo(1 - 2 * MIN_FRACTION, 5);
    expect(next[1]).toBeCloseTo(MIN_FRACTION, 5);
  });

  it('clamps a request under the floor rather than starving the member', () => {
    const next = resizeShare([0.5, 0.5], 0, 0);
    expectInvariant(next, 'floor');
    expect(next[0]).toBeCloseTo(MIN_FRACTION, 5);
  });

  it('is idempotent — a re-sent resize to the size already in force changes nothing', () => {
    const once = resizeShare([0.25, 0.5, 0.25], 1, 0.6);
    const twice = resizeShare(once, 1, 0.6);
    expect(twice).toEqual(once);
  });
});

describe('property: any sequence of rebalances and resizes preserves the invariant', () => {
  it('holds across seeded random sequences', () => {
    // Seeded LCG rather than fast-check (not a dependency of this repo), so a
    // failure reproduces from its logged seed.
    let seed = 0x2f6e2b1;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let run = 0; run < 200; run += 1) {
      let shares: Array<number | null> = [null, null];
      for (let step = 0; step < 12; step += 1) {
        const roll = next();
        if (roll < 0.35) {
          // Insert a newcomer.
          shares = rebalanceFractions([...shares, null]);
        } else if (roll < 0.6 && shares.length > 1) {
          // Remove a member.
          const victim = Math.floor(next() * shares.length);
          shares = rebalanceFractions(shares.filter((_, index) => index !== victim));
        } else {
          // Resize one, materializing the container if it was unsized.
          const index = Math.floor(next() * shares.length);
          shares = resizeShare(currentShares(shares), index, next());
        }
        expectInvariant(shares, `run ${run} step ${step} (seed 0x2f6e2b1)`);
      }
    }
  });
});
