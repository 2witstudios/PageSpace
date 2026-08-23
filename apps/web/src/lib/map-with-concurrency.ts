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
 * `resolveWorkerCount` is the whole subtlety. It stays module-private and is
 * exercised through `mapWithConcurrency` rather than directly: knip ignores
 * `src/**/__tests__/**`, so an export whose only consumer is a test counts as
 * dead code and fails the unused-code gate. Going through the real entry point
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
 * a worker already suspended mid-await still completes the index it claimed, so
 * the claimed prefix is never left holed.
 */
function resolveWorkerCount(limit: number, itemCount: number): number {
  if (itemCount === 0) return 0;
  const requested = Number.isFinite(limit) ? Math.floor(limit) : 1;
  return Math.min(Math.max(1, requested), itemCount);
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
