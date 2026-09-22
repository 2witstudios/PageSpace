/**
 * `decidePolicyUsage` — whether a standing (`always`) policy still covers one
 * more use (L2·G2 review, Codex P1; ADR 0004 §4.3 limits). Pure.
 *
 * The policy is the PLANE's stored copy (`PlaneScope.approvalPolicy`) and the
 * usage comes from the plane's own ledger, so a main-DB writer can neither
 * raise a cap nor reset a count. Expired: no policy, not policy-shaped, or past
 * its deadline. Limits exceeded: this hour's uses at the cap, requests in
 * flight at the concurrency cap, or this request's bytes pushing the hour past
 * the byte cap — and any cap that is not a finite number, which never means
 * "unlimited".
 */
import type { UsageCounters } from '../approval';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export function decidePolicyUsage({
  policy,
  usage,
  requestBytes,
  now,
}: {
  readonly policy: unknown;
  readonly usage: UsageCounters;
  readonly requestBytes: number;
  readonly now: number;
}): { readonly expired: boolean; readonly limitsExceeded: boolean } {
  if (!isObject(policy) || !isObject(policy.scope) || !('duration' in policy)) return { expired: true, limitsExceeded: false };
  const { duration, limits } = policy;
  const expired = duration !== null && (!isObject(duration) || !finite(duration.until) || duration.until <= now);
  if (!isObject(limits) || !finite(limits.maxUsesPerHour) || !finite(limits.maxBytesOut) || !finite(limits.maxConcurrent)) return { expired, limitsExceeded: true };
  const limitsExceeded =
    usage.usesThisHour >= limits.maxUsesPerHour || usage.concurrent >= limits.maxConcurrent || usage.bytesOutThisHour + requestBytes > limits.maxBytesOut;
  return { expired, limitsExceeded };
}
