/**
 * FRACTIONS — how a container's members divide it, and the one rule that keeps
 * that division well-formed.
 *
 * A primitive, not a layout model. It knows nothing about panes, columns, nodes
 * or trees: it takes a list of shares and returns a list of shares. Every caller
 * — the node algebra's `resize`, the validator's sum check, the store's read
 * funnel, the backfill's derivation — asks the same question of it, which is why
 * there is exactly one answer to be had.
 *
 * **It lived in `workspace-layout-verbs.ts` and that was the mistake.** The node
 * model, which replaced the layout model outright, still had to import its
 * fraction arithmetic FROM the model it replaced — the successor depending on its
 * predecessor, and the reason the old model could not be deleted. Nothing here
 * was ever layout-specific; it lived there because that is where sizing was first
 * needed (issue #2208). It was MOVED rather than copied: two epsilons that can
 * drift is a worse defect than the import ever was.
 */

/**
 * How far a fraction sum may drift from 1 and still count as satisfying the
 * invariant. Float arithmetic makes exact equality untestable; every function
 * here settles its own residual (see {@link settleToOne}), so real drift stays
 * far below this.
 */
export const FRACTION_EPSILON = 1e-6;

/**
 * The smallest share a member may hold. A resize that would starve a sibling
 * is CLAMPED to this rather than refused — a resize is total, and "you asked for
 * something impossible" is not a failure mode a layout needs. The renderer
 * enforces its own, stricter drag minimum on top; this is the structural floor
 * that keeps a pane from becoming unclickable, not a UI constant.
 */
export const MIN_FRACTION = 0.05;

/**
 * The grid every stored fraction snaps to (1e-5 — a hundredth of a percent of
 * a container, orders of magnitude finer than a pixel).
 *
 * This is NOT cosmetic rounding. The columns are Postgres `real` (float4), so
 * a double written out does not read back bit-identical, and a reader that
 * compares what it read against what it is about to write would see every write
 * as a change. Snapping both the producer's output and the reader's input to the
 * same coarse grid makes the round-trip an identity: float4's relative error
 * (~6e-8) is ~80x smaller than the distance from a grid point to its rounding
 * boundary (5e-6), so `q(float4(q(x))) === q(x)` with room to spare.
 */
const FRACTION_PRECISION = 1e-5;

/**
 * Snap a fraction to {@link FRACTION_PRECISION}. See its doc for why this exists.
 *
 * Round to an INTEGER number of steps, then divide by the integer scale —
 * never divide-then-multiply by the precision. `Math.round(0.75 / 1e-5) * 1e-5`
 * is `0.7500000000000001`: the trailing multiply reintroduces exactly the error
 * the round just removed. Dividing an integer by an exact integer scale
 * (`1e5`, not `1 / 1e-5`, which is itself `100000.00000000001`) lands on the
 * nearest representable double instead.
 *
 * Verified idempotent and stable across the `real`/float4 storage round trip
 * at this precision.
 */
const FRACTION_SCALE = 1e5;

export function quantizeFraction(value: number): number {
  return Math.round(value * FRACTION_SCALE) / FRACTION_SCALE;
}

/**
 * A stored fraction in canonical form, or `null` when it is absent,
 * non-finite, or not positive. THE funnel through which an external number
 * (a row, a wire payload, a hand-written blob) becomes a fraction anything
 * will compare, render or persist.
 *
 * The funnel is shared by server and client deliberately. A wire fraction is an
 * unbounded `z.number().nullable().optional()`, so a `0` or a negative passes
 * schema validation; a reader that admitted those with a bare
 * `typeof x === 'number'` would render a 0%-sized member while another reader
 * treated the same row as unsized and split it evenly. The two disagreed until
 * the next transition happened to heal it.
 */
export function readFraction(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? quantizeFraction(value) : null;
}

/**
 * Put a container's shares in canonical form: every member snapped to the
 * precision grid, and the residual folded into the LARGEST member so the sum
 * is 1 to within float representation error.
 *
 * The residual lands on the largest, never on the last: whichever member
 * happens to be final could be a small one, and pushing it under
 * {@link MIN_FRACTION} would break the very invariant this exists to close.
 * Recomputing the largest as `1 - everything else` (rather than adding a
 * correction to it) keeps it ON the grid, since both terms already are.
 */
function settleToOne(values: number[]): number[] {
  if (values.length === 0) return values;
  const settled = values.map(quantizeFraction);
  let largest = 0;
  for (let index = 1; index < settled.length; index += 1) {
    if (settled[index] > settled[largest]) largest = index;
  }
  const others = settled.reduce((sum, value, index) => (index === largest ? sum : sum + value), 0);
  settled[largest] = quantizeFraction(1 - others);
  return settled;
}

/**
 * Scale `values` so they sum to `total`, with no member below the floor.
 *
 * Proportional scaling alone cannot honor a floor: squeezing a large sibling
 * in can drive a small one under it. So this water-fills — pin whatever fell
 * under the floor AT the floor, redistribute the remaining budget across the
 * rest in proportion, repeat. The pinned set only ever grows (pinning shrinks
 * the budget for everyone else), so this terminates in at most one pass per
 * member; the loop bound is a statement of that, not a hope.
 *
 * `total / n` caps the floor, so a container too small to give everyone
 * `MIN_FRACTION` degrades to an even split instead of demanding more than 100%.
 */
function scaleToTotal(values: number[], total: number): number[] {
  const count = values.length;
  if (count === 0) return [];
  const floor = Math.min(MIN_FRACTION, total / count);
  const sum = values.reduce((running, value) => running + value, 0);
  let shares = sum > 0 ? values.map((value) => (value / sum) * total) : values.map(() => total / count);

  for (let pass = 0; pass < count; pass += 1) {
    const pinned = shares.map((share) => share < floor);
    const pinnedCount = pinned.filter(Boolean).length;
    if (pinnedCount === 0 || pinnedCount === count) break;
    const budget = total - floor * pinnedCount;
    const freeSum = shares.reduce((running, share, index) => (pinned[index] ? running : running + share), 0);
    shares = shares.map((share, index) =>
      pinned[index]
        ? floor
        : freeSum > 0
          ? (share / freeSum) * budget
          : budget / (count - pinnedCount),
    );
  }

  return shares.map((share) => (share < floor ? floor : share));
}

/**
 * THE FRACTION INVARIANT, and the one function that establishes it.
 *
 * For any container (a root's children, or one split's members) exactly one of
 * these holds:
 *
 *  - **Unsized** — EVERY member's fraction is absent. Nobody has ever resized
 *    this container, and the renderer splits it evenly. This is the opening
 *    state and it is deliberately not `1/n` rows: writing shares nobody chose
 *    would make every insertion a sizing change.
 *  - **Sized** — EVERY member's fraction is a finite number `>= MIN_FRACTION`,
 *    and they sum to 1 within {@link FRACTION_EPSILON}.
 *
 * A container is never MIXED, in either direction: a resize materializes the
 * whole container (unsized siblings start from their even share), and a
 * membership change re-establishes the invariant for the new membership. Input
 * that arrives mixed — hand-crafted, or written by some future partial writer —
 * is read as UNSIZED wholesale rather than half-trusted, because a subset of
 * fractions summing to less than 1 has no defensible rendering.
 *
 * `before` is what each member of the NEW membership carried; `null` marks a
 * newcomer (a fresh pane, or one moved in from another container). Newcomers
 * take an even share of the new container and the survivors keep their
 * relative proportions inside whatever is left.
 */
export function rebalanceFractions(before: Array<number | null | undefined>): Array<number | null> {
  const count = before.length;
  if (count === 0) return [];
  // A LONE member is always unsized: it owns its whole container, so a stored
  // `1.0` states nothing the structure does not already say — and it would
  // make a container that had shrunk to one look "sized", so the next
  // insertion into it would rebalance against a share nobody chose. A resize
  // of a one-member container is refused for the same reason.
  if (count === 1) return [null];
  const known = before.map(readFraction);
  if (known.every((fraction) => fraction === null)) return known;

  const newcomerShare = 1 / count;
  const newcomers = known.filter((fraction) => fraction === null).length;
  // `newcomers < count` here (an all-null container returned above), so the
  // survivors' budget is always positive.
  const survivors = scaleToTotal(
    known.filter((fraction): fraction is number => fraction !== null),
    1 - newcomerShare * newcomers,
  );
  let survivorIndex = 0;
  const merged = known.map((fraction) =>
    fraction === null ? newcomerShare : survivors[survivorIndex++],
  );
  return settleToOne(merged);
}

/**
 * The shares a container currently renders at: its stored fractions when it is
 * sized, an even split when it is not. The starting point every resize
 * materializes from.
 */
export function currentShares(before: Array<number | null | undefined>): number[] {
  const known = before.map(readFraction);
  if (known.some((fraction) => fraction === null)) return known.map(() => 1 / known.length);
  return settleToOne(scaleToTotal(known as number[], 1));
}

/**
 * Give member `index` the share it asked for and let the others absorb the
 * difference in proportion. The request is CLAMPED into what the floor leaves
 * available rather than refused — see {@link MIN_FRACTION}.
 */
export function resizeShare(shares: number[], index: number, requested: number): number[] {
  const count = shares.length;
  const floor = Math.min(MIN_FRACTION, 1 / count);
  const ceiling = 1 - floor * (count - 1);
  const target = Math.min(Math.max(requested, floor), ceiling);
  const others = scaleToTotal(
    shares.filter((_, other) => other !== index),
    1 - target,
  );
  let otherIndex = 0;
  return settleToOne(shares.map((_, member) => (member === index ? target : others[otherIndex++])));
}
