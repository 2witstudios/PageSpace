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

// Every realistic way to get the request's abort signal.
//
// The first pattern alone was NOT enough, and I only found that by trying to defeat my own
// guard: `const { signal } = request;` — the most natural way a developer would actually write
// it — sailed straight past a member-access-only check. The test stayed green while
// disconnect-immunity was destroyed, which is precisely the false comfort this file exists to
// prevent. A tripwire that only catches the spelling you happened to think of is not a tripwire.
const REQUEST_SIGNAL_PATTERNS = [
  // request.signal / req.signal
  /\b(request|req)\s*\.\s*signal\b/,
  // const { signal } = request  /  const { signal: alias } = req
  /\{[^}]*\bsignal\b[^}]*\}\s*=\s*(request|req)\b/,
];

// This is a heuristic, deliberately. It cannot catch every conceivable aliasing
// (`const r = request; r.signal`), and it is not trying to be a type system. It catches the ways
// this mistake actually gets made — a direct read and a destructure — and it fails loudly with an
// explanation, which is worth far more than a proof nobody writes.
const readsRequestSignal = (line: string): boolean =>
  REQUEST_SIGNAL_PATTERNS.some((re) => re.test(line));

describe('disconnect-immunity (AC7)', () => {
  describe.each(GENERATION_ROUTES)('%s', (relPath) => {
    it('never reads the incoming request\'s abort signal — a client hanging up must not kill the generation', () => {
      const source = readFileSync(join(WEB_SRC, relPath), 'utf8');

      const offendingLines = source
        .split('\n')
        .map((line, i) => ({ line: line.trim(), lineNo: i + 1 }))
        .filter(({ line }) => readsRequestSignal(line))
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
    expect(readsRequestSignal(source)).toBe(true);
  });
});
