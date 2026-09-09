/**
 * `Promise.all` over `items`, at most `limit` in flight, preserving input order.
 *
 * Order matters wherever this is used for a report a human diffs between runs:
 * a settle-as-they-finish result would reshuffle it for no reason.
 *
 * Lives in its own module rather than beside its caller so the edge cases below
 * can be tested directly. They were not, when this was a private helper inside
 * a route: the caller passes a hardcoded limit, so no test could reach a
 * non-positive one, and the guard that was supposed to prevent a hole-filled
 * array could be deleted with every test still green.
 *
 * `resolveWorkerCount` carries the whole subtlety. It stays module-private and is
 * exercised through `mapWithConcurrency` rather than directly: knip ignores this
 * app's `__tests__` directories, so an export whose only consumer is a test
 * counts as dead code and fails the unused-code gate. (Spelling that ignore
 * pattern out as a glob here would end this comment early — it contains the
 * close-comment sequence.) Going through the real entry point
 * is the better test anyway — the edge cases below still turn red if the guard
 * is removed. A non-positive — or non-finite —
 * limit would start zero workers, and this function would then resolve
 * `new Array(n)`: typed `TResult[]`, actually a row of holes, with no work done
 * and no error raised. A caller serializing that reports every item as null,
 * which is a far worse failure than being slow.
 *
 * The first rejection stops the queue as well as propagating. `Promise.all`
 * rejects immediately but does not cancel its siblings, so without the flag the
 * remaining workers keep draining — spending the whole fan-out the limit exists
 * to contain on a result that has already failed. `failed` is set synchronously
 * in `catch` before the rethrow, so no worker can claim a new index afterwards;
 * a worker already suspended mid-await still completes the index it claimed.
 * The index that FAILED is of course left unwritten, which is why a rejection
 * must propagate rather than be swallowed — the array is never returned in that
 * state, and there is no path where `Promise.all` resolves over a hole.
 */
function resolveWorkerCount(limit: number, itemCount: number): number {
  // `Infinity` means "no ceiling", so it resolves to one worker per item.
  // Anything else non-finite (`NaN`) is a caller bug rather than an intent, and
  // falls back to serial — the slowest correct answer, never a wrong one.
  if (!Number.isFinite(limit)) return limit === Number.POSITIVE_INFINITY ? itemCount : Math.min(1, itemCount);
  // The `Math.min` is an allocation guard with NO observable behaviour: extra
  // workers past `itemCount` would immediately see `index >= items.length` and
  // exit, so results and call counts are identical either way. Deliberately
  // untested for that reason — there is nothing a test could assert that would
  // distinguish it, and a test that cannot fail is worse than none.
  return Math.min(Math.max(1, Math.floor(limit)), itemCount);
}

export async function mapWithConcurrency<TItem, TResult>(
  items: readonly TItem[],
  limit: number,
  resolve: (item: TItem) => Promise<TResult>,
): Promise<TResult[]> {
  const results: TResult[] = new Array(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from({ length: resolveWorkerCount(limit, items.length) }, async () => {
    for (let index = next++; index < items.length && !failed; index = next++) {
      try {
        results[index] = await resolve(items[index]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  });
  await Promise.all(workers);
  return results;
}
