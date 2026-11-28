/**
 * Structural check for "is this a promise-like value" without relying on
 * `instanceof Promise` — `sendFn()` can return the result of an async
 * function, a thenable from a third-party lib, or a plain synchronous value,
 * and only the first two need their rejection routed to the caller.
 *
 * Pure — no I/O, no side effects.
 */
export const isThenable = (value: unknown): value is PromiseLike<unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { then?: unknown };
  return typeof candidate.then === 'function';
};
