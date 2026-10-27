import { vi } from 'vitest';
import { AIMonitoring } from '@pagespace/lib/monitoring/ai-monitoring';

type TrackUsage = typeof AIMonitoring.trackUsage;
type UsageData = Parameters<TrackUsage>[0];
type UsageOutcome = ReturnType<TrackUsage>;

/**
 * Every usage settle (AIMonitoring.trackUsage) a code path starts, held so a test can wait
 * for exactly those to finish.
 *
 * The memory services settle fire-and-forget (discardUsageOutcome), so a route can return
 * before its last settle has written anything. Polling the usage rows cannot see a settle
 * that has not written its row yet: it reads "every row there is, applied" and returns
 * early, while that call's hold is still live. This waits on the settles themselves.
 */
export interface UsageSettles {
  /** Resolves once every settle started so far, and any started while waiting, has finished. */
  drain(): Promise<void>;
  restore(): void;
}

/**
 * `intercept` stands between a call and its real settle, so a test can hold one back
 * (`settle` runs the real trackUsage). Without it, every call settles at once.
 */
export function captureUsageSettles(
  intercept?: (data: UsageData, settle: () => UsageOutcome) => UsageOutcome,
): UsageSettles {
  const original = AIMonitoring.trackUsage;
  const started: UsageOutcome[] = [];
  const spy = vi.spyOn(AIMonitoring, 'trackUsage').mockImplementation((data) => {
    const outcome = intercept ? intercept(data, () => original(data)) : original(data);
    started.push(outcome);
    return outcome;
  });
  return {
    async drain() {
      let seen = 0;
      while (seen < started.length) {
        const batch = started.slice(seen);
        seen = started.length;
        await Promise.allSettled(batch);
      }
    },
    restore: () => spy.mockRestore(),
  };
}
