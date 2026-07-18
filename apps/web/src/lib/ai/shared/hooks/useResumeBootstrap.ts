import { useCallback } from 'react';
import { useAppStateRecovery } from '@/hooks/useAppStateRecovery';
import { planResumeBootstrap } from '@/lib/ai/streams/planResumeBootstrap';

export interface UseResumeBootstrapOptions {
  /** Re-bootstrap this surface's channel(s) onto usePendingStreamsStore (a live stream resumes visibly; a finished one is absent — reload covers it). */
  rejoin: () => void;
  /** Reload the conversation on screen into the cache store (loadGeneration makes a racing stale response harmless). */
  reload: () => Promise<void>;
  /** Settle this surface's local transport if it still thinks it is streaming (a frozen fetch after backgrounding). */
  stop: () => void;
  /** Is a genuinely live OWN stream running for the conversation on screen, read at fire time (not a render-time boolean — iOS freezes JS on background). */
  isOwnStreamLive: () => boolean;
  /** Gate on user editing only, evaluated at fire time. */
  enabled: () => boolean;
}

/**
 * App-resume = the same path as mount and socket-reconnect: re-bootstrap
 * active streams, reload the conversation into the cache, and settle a
 * frozen local transport. Under store-first rendering nothing renders from
 * the local fetch, so there is no longer a native/web or
 * was-i-streaming branch to choreograph — the sequence is idempotent and
 * cheap enough to run unconditionally every time. The only guard left is
 * never stopping a genuinely live own fetch (subsumes #2065 and
 * resolveResumeAction on all three surfaces — see epic leaf 6.2).
 */
export function useResumeBootstrap({
  rejoin,
  reload,
  stop,
  isOwnStreamLive,
  enabled,
}: UseResumeBootstrapOptions): void {
  useAppStateRecovery({
    onResume: useCallback(async () => {
      const effects = planResumeBootstrap(isOwnStreamLive());
      rejoin();
      await reload();
      if (effects.includes('stop')) {
        stop();
      }
    }, [rejoin, reload, stop, isOwnStreamLive]),
    enabled,
  });
}
