import { useCallback } from 'react';
import { useAppStateRecovery } from '@/hooks/useAppStateRecovery';

export interface UseResumeBootstrapOptions {
  /** Re-bootstrap this surface's channel(s): a live stream resumes visibly; a finished one is absent, and reload covers it. */
  rejoin: () => void;
  /** Reload the conversation on screen into the cache store (loadGeneration makes a racing stale response harmless). */
  reload: () => Promise<void>;
  /** Gate on user editing only, evaluated at fire time. */
  enabled: () => boolean;
}

/**
 * App-resume = the same path as mount and socket-reconnect: re-bootstrap active streams and
 * reload the conversation into the cache.
 *
 * ── THE THIRD STEP IS GONE ────────────────────────────────────────────────────────────────
 *
 * This used to end with "settle a frozen local transport" — a `stop()` on the surface's
 * `useChat`, fired when `planResumeBootstrap` decided no genuinely live own stream was
 * running. It existed because iOS freezes JS when a WKWebView is backgrounded, so a `fetch`
 * could come back with its response body wedged and the chat stuck reporting `streaming`
 * forever, showing a Stop button over nothing.
 *
 * There is no local transport to settle. `useChatSession` reads no response body — the POST
 * returns an admission envelope and the stream arrives over a subscription the module-scope
 * registry owns — so "a frozen fetch" is not a state this client can be in. `rejoin()`
 * re-reconciles that registry against the server's own list of what is still running, which
 * is a stronger answer than a local settle ever was: it can tell a stream that DIED while the
 * tab was backgrounded from one that is still generating, which the `stop()` heuristic could
 * only guess at.
 *
 * `planResumeBootstrap` and its `isOwnStreamLive` probe are deleted with it — the probe's only
 * consumer was the decision of whether to fire that stop. A resume must never abort a live
 * generation, and now it structurally cannot: there is no abort on this path at all.
 * `only-a-deliberate-stop.test.ts` fails if one is reintroduced.
 */
export function useResumeBootstrap({ rejoin, reload, enabled }: UseResumeBootstrapOptions): void {
  useAppStateRecovery({
    onResume: useCallback(async () => {
      rejoin();
      await reload();
    }, [rejoin, reload]),
    enabled,
  });
}
