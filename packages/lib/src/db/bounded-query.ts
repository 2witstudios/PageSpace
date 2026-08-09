/**
 * Bounded query primitive — pure, no DB access.
 *
 * Every list query must carry a hard-bounded limit before it reaches the
 * database: an unbounded `findMany` is what OOM-crashed Postgres when the
 * task-board route fetched every task with five joined relations at once.
 * `resolveBoundedLimit` requires a `bounds` policy alongside the raw query
 * param so a caller cannot accidentally pass an unclamped limit through.
 */

export interface ParseBoundedIntParamOptions {
  defaultValue: number;
  min?: number;
  max?: number;
}

/**
 * Parse a numeric query param safely with explicit bounds.
 * Falls back to the bounded default value when the input is missing or invalid.
 */
export function parseBoundedIntParam(
  rawValue: string | null,
  options: ParseBoundedIntParamOptions
): number {
  const min = options.min ?? Number.MIN_SAFE_INTEGER;
  const max = options.max ?? Number.MAX_SAFE_INTEGER;
  const boundedDefault = Math.min(max, Math.max(min, options.defaultValue));

  if (!rawValue) {
    return boundedDefault;
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    return boundedDefault;
  }

  return Math.min(max, Math.max(min, parsed));
}

export interface BoundedQueryLimitPolicy {
  /** Applied when the caller omits a limit. */
  defaultValue: number;
  /** Requests above this are clamped down to it. */
  max: number;
  /** Requests below this are clamped up to it. Defaults to 1. */
  min?: number;
}

/**
 * Resolve a caller-supplied `limit` query param into a value guaranteed to
 * sit within the given policy's bounds, for passing straight into `findMany`.
 */
export function resolveBoundedLimit(
  rawLimit: string | null,
  bounds: BoundedQueryLimitPolicy
): number {
  return parseBoundedIntParam(rawLimit, {
    defaultValue: bounds.defaultValue,
    min: bounds.min ?? 1,
    max: bounds.max,
  });
}
