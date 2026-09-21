import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * A QUEUED SEND MUST NEVER DISPATCH WHILE A STREAM IS LIVE.
 *
 * The server's second POST for a conversation takes the stream over and aborts
 * the live generation. A queued message dispatched while any stream — this
 * tab's own, or a remote surface's — is still running would take the turn over
 * and kill the reply someone is watching. That is the exact disaster the
 * queue exists to avoid, and it is attractive to reintroduce "sensibly": a
 * drain timer "just to be safe", a dispatch that skips the liveness check
 * "because the end event just fired", a drain that respects the stopRequests
 * epoch "for consistency" (a Stop's epoch would then permanently wedge the
 * queue — a queued message is the OPPOSITE of a racing read; it is deliberate).
 *
 * ── WHY SOURCE-LEVEL ───────────────────────────────────────────────────────
 *
 * Same reasoning as `only-a-deliberate-stop.test.ts`: what must never come
 * back is the WIRING, anywhere. A behavioural test pins only the paths it
 * exercises; the failure modes here are all one refactor away from a path
 * nobody exercises. IF THIS FAILS, do not adjust the patterns — ask what the
 * new code is trying to do, because a queue drain has exactly one legal
 * trigger and four guards, all below.
 */

const WEB_SRC = join(import.meta.dirname, '../../../../..');

const DRAIN_HOOK = 'lib/ai/shared/hooks/useQueuedSends.ts';

const isComment = (line: string): boolean =>
  line.startsWith('//') || line.startsWith('*') || line.startsWith('/*');

const executableSource = (relPath: string): string =>
  readFileSync(join(WEB_SRC, relPath), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !isComment(line))
    .join('\n');

describe('queued dispatch never while live', () => {
  it('the drain has no timer — it fires only on the observed end of a stream', () => {
    const source = executableSource(DRAIN_HOOK);

    expect(
      /setTimeout|setInterval|setImmediate/.test(source),
      'useQueuedSends has grown a timer. The drain must fire ONLY when the stream session '
        + 'registry reports an end event (onStreamSessionEnd). A timer drain guesses when a '
        + 'stream is over — and guessing means dispatching while a generation is still live, '
        + 'which takes the turn over server-side and aborts the reply someone is reading.',
    ).toBe(false);

    expect(
      source.includes('onStreamSessionEnd'),
      'useQueuedSends no longer subscribes to onStreamSessionEnd. Without it there is no drain '
        + 'trigger at all: queued messages would sit forever after every completed turn.',
    ).toBe(true);
  });

  it('the drain keeps all four guards, in order, before it dispatches', () => {
    const source = executableSource(DRAIN_HOOK);

    const order = (marker: RegExp): number => {
      const match = source.match(marker);
      expect(match, `Guard ${marker} is missing from useQueuedSends. See the file's docblock: `)
        .not.toBeNull();
      return match!.index!;
    };

    const suppression = order(/drainSuppressions\.has\(/);
    const claimFreshness = order(/claim\.at < CLAIM_FANOUT_WINDOW_MS/);
    const liveness = order(/if \(hasOtherLiveStream\(/);
    const submitted = order(/statusRef\.current === 'submitted'/);
    const dispatch = order(/conversationMessagesActions\.shiftQueuedSend\(/);

    expect(suppression).toBeLessThan(claimFreshness);
    expect(claimFreshness).toBeLessThan(liveness);
    expect(liveness).toBeLessThan(submitted);
    expect(submitted).toBeLessThan(dispatch);
  });

  it('the drain does not consult the stopRequests epoch — a Stop must not wedge the queue', () => {
    const source = executableSource(DRAIN_HOOK);

    expect(
      /readStopEpoch|recordStopRequest/.test(source),
      'useQueuedSends now touches stopRequests. The drain must NOT respect the stop epoch: a '
        + 'queued send is a deliberate, ordered message — the exact opposite of the racing '
        + 'second read the epoch guard exists to prevent. Wiring the epoch in here means one '
        + 'ESC press permanently silences every queued message in the conversation.',
    ).toBe(false);
  });

  it('shiftQueuedSend has no callers outside the store, the facade, and the end-event drain', () => {
    const ALLOWED = new Set([
      'stores/conversationMessages/applyQueuedSends.ts',
      'stores/useConversationMessagesStore.ts',
      'hooks/conversationMessagesActions.ts',
      'lib/ai/shared/hooks/useQueuedSends.ts',
      'stores/conversationMessages/__tests__/queuedSends.test.ts',
      'lib/ai/shared/hooks/__tests__/useQueuedSends.test.tsx',
      'lib/ai/shared/hooks/__tests__/queued-dispatch-never-while-live.test.ts',
    ]);

    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules' || entry === '.next') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry)) continue;
        const rel = relative(WEB_SRC, full);
        if (ALLOWED.has(rel)) continue;
        if (readFileSync(full, 'utf8').includes('shiftQueuedSend')) offenders.push(rel);
      }
    };
    walk(WEB_SRC);

    expect(
      offenders,
      'A new module shifts the send queue. The ONLY thing that may dequeue a queued message is '
        + 'the drain inside useQueuedSends, and it runs only on an onStreamSessionEnd event '
        + 'after the four guards. Any other caller can dispatch while a stream is live — the '
        + 'one disaster this feature exists to prevent.',
    ).toEqual([]);
  });
});
