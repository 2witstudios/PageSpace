import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The load-bearing invariant of server-owned streams, and the only one with no natural place
 * to assert itself.
 *
 * A stream is a SERVER-SIDE entity. The client is a subscriber. The whole architecture rests on
 * one fact: the generation does not die when the client goes away. That is why `request.signal`
 * is never wired into `streamText` — an aborted HTTP request means "this client stopped
 * listening", NOT "the user wants the agent to stop". Only an explicit user stop aborts a
 * stream, via the abort registry keyed by messageId.
 *
 * Wire `request.signal` in and everything silently reverts to client-owned streams: reloading
 * the tab (which iOS does constantly — it jetsams the WKWebView content process and Capacitor
 * calls webView.reload()) kills the generation mid-tool-call, mid-page-edit. Nothing fails
 * loudly. No test breaks. The tab just quietly starts murdering its own agent again, and the
 * bug this entire PR exists to fix comes back.
 *
 * It is a one-line change to break, it looks like an obvious cleanup ("we're leaking a
 * generation when the client disconnects!"), and it is invisible in review unless you already
 * know. So it gets a tripwire.
 *
 * This is deliberately a SOURCE-LEVEL assertion. A behavioural test would have to mock
 * `streamText` and drive an aborted request through the whole route — heavy, and it would only
 * pin the one path it exercised. What we actually want to forbid is the *presence* of the
 * wiring, anywhere in the generation routes, forever.
 *
 * If this test fails, do not "fix" it by editing the allowlist. Read `stream-abort-registry.ts`
 * and `route.ts`'s abort-controller comment first, then decide whether you really mean it.
 */

const WEB_SRC = join(import.meta.dirname, '../../../..');

// The two routes that START a generation. These may never observe the request's abort signal.
const GENERATION_ROUTES = [
  'app/api/ai/chat/route.ts',
  'app/api/ai/global/[id]/messages/route.ts',
];

// `request.signal` / `req.signal`, in any member-access shape.
const REQUEST_SIGNAL = /\b(request|req)\s*\.\s*signal\b/;

describe('disconnect-immunity (AC7)', () => {
  describe.each(GENERATION_ROUTES)('%s', (relPath) => {
    it('never reads the incoming request\'s abort signal — a client hanging up must not kill the generation', () => {
      const source = readFileSync(join(WEB_SRC, relPath), 'utf8');

      const offendingLines = source
        .split('\n')
        .map((line, i) => ({ line: line.trim(), lineNo: i + 1 }))
        .filter(({ line }) => REQUEST_SIGNAL.test(line))
        // A comment explaining WHY we don't do this is exactly what we want to keep.
        .filter(({ line }) => !line.startsWith('//') && !line.startsWith('*') && !line.startsWith('/*'));

      expect(
        offendingLines,
        `${relPath} reads the request's abort signal. A stream is a server-owned entity: the `
        + `client disconnecting means it stopped LISTENING, not that the user pressed Stop. `
        + `Wiring this into streamText (or into AbortSignal.any alongside the stream's own `
        + `controller) makes every tab reload kill its own in-flight generation mid-tool-call — `
        + `the exact bug server-owned streams exist to fix, and it fails silently.\n`
        + `Only an explicit user stop may abort: see abortStreamByMessageId in `
        + `stream-abort-registry.ts.`,
      ).toEqual([]);
    });
  });

  // The subscriber side is the mirror image, and MUST use request.signal: an SSE reader going
  // away has to detach from the multicast, or the registry leaks a subscriber per dead tab.
  // Asserted so nobody "helpfully" applies the rule above to the wrong route.
  it('stream-join DOES observe the request signal — a departing subscriber must detach', () => {
    const source = readFileSync(
      join(WEB_SRC, 'app/api/ai/chat/stream-join/[messageId]/route.ts'),
      'utf8',
    );
    expect(REQUEST_SIGNAL.test(source)).toBe(true);
  });
});
