import { describe, it } from 'vitest';
import { assert } from './riteway';
import {
  handleShellReadRequest,
  handleShellSendRequest,
  MAX_SHELL_INPUT_BYTES,
  scrollbackTail,
  planSessionStart,
  MAX_SCROLLBACK_TAIL_BYTES,
  type ShellIoDeps,
} from '../shell-io';
import { appendScrollback, type TerminalSession } from '../terminal-session-map';
import { MAX_SHELLS_PER_READ, MAX_SCROLLBACK_TAIL_LINES } from '@pagespace/lib/agent-sessions/contract';

function makeSession(over: Partial<TerminalSession> = {}): TerminalSession {
  return {
    command: {} as TerminalSession['command'],
    sandboxId: 'sbx-1',
    sessionKey: 'key-1',
    lastViewerUserId: 'user1',
    releaseSlot: () => {},
    viewers: new Map(),
    scrollback: [],
    scrollbackBytes: 0,
    hasOutput: false,
    resumedAtCreate: false,
    ...over,
  } as TerminalSession;
}

/** A session with `text` already in its ring — written through the real appender. */
function sessionWithOutput(text: string): TerminalSession {
  const session = makeSession();
  appendScrollback(session, text);
  return session;
}

function deps(sessions: Record<string, TerminalSession> = {}): ShellIoDeps {
  return {
    sessionMap: { getByKey: (key: string) => sessions[key] },
    // The pure key derivation the socket handler uses, stubbed to the same
    // shape: the shellId in, one opaque string out.
    sessionKeyFor: (shellId) => `k:${shellId}`,
  };
}

function readBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ shellIds: ['sh'], ...over });
}

describe('handleShellReadRequest — validation', () => {
  it('given invalid JSON, should refuse with 400', async () => {
    const result = await handleShellReadRequest(deps(), 'not json');
    assert({
      given: 'a body that is not JSON',
      should: 'refuse with 400 rather than guessing a payload',
      actual: result.status,
      expected: 400,
    });
  });

  it('given no shellIds, should refuse with 400', async () => {
    const result = await handleShellReadRequest(deps(), JSON.stringify({ limit: 0 }));
    assert({
      given: 'a payload naming no shells at all',
      should: 'refuse with 400',
      actual: { status: result.status, error: result.body.error },
      expected: { status: 400, error: 'Missing or invalid shellIds' },
    });
  });

  it('given an empty shellIds list, should refuse with 400', async () => {
    const result = await handleShellReadRequest(deps(), readBody({ shellIds: [] }));
    assert({
      given: 'a payload naming no shells',
      should: 'refuse with 400',
      actual: { status: result.status, error: result.body.error },
      expected: { status: 400, error: 'Missing or invalid shellIds' },
    });
  });

  it('given a non-integer or negative limit, should refuse with 400', async () => {
    const negative = await handleShellReadRequest(deps(), readBody({ limit: -1 }));
    const fractional = await handleShellReadRequest(deps(), readBody({ limit: 1.5 }));
    assert({
      given: 'a limit that is not a non-negative integer',
      should: 'refuse with 400 rather than coercing — a signed endpoint validates every field it interpolates into behavior',
      actual: [negative, fractional].map((r) => ({ status: r.status, error: r.body.error })),
      expected: [
        { status: 400, error: 'Invalid limit' },
        { status: 400, error: 'Invalid limit' },
      ],
    });
  });

  it('given a limit over the contract bound, should refuse with 400 — no unbounded number crosses the hop', async () => {
    const result = await handleShellReadRequest(deps(), readBody({ limit: MAX_SCROLLBACK_TAIL_LINES + 1 }));
    assert({
      given: 'a limit beyond what the byte-capped answer could ever ship',
      should: 'refuse with 400 rather than accepting an unbounded ask',
      actual: { status: result.status, error: result.body.error },
      expected: { status: 400, error: 'Invalid limit' },
    });
  });

  it('given more shellIds than one listing can mean, should refuse with 400', async () => {
    const shellIds = Array.from({ length: MAX_SHELLS_PER_READ + 1 }, (_, index) => `sh-${index}`);
    const result = await handleShellReadRequest(deps(), readBody({ shellIds }));
    assert({
      given: 'a read naming more shells than the sweep bound',
      should: 'refuse with 400 — a read is a session\'s listing, not a crawl',
      actual: { status: result.status, error: result.body.error },
      expected: { status: 400, error: 'Missing or invalid shellIds' },
    });
  });
});

describe('handleShellSendRequest — validation', () => {
  it('given invalid JSON, should refuse with 400', async () => {
    const result = await handleShellSendRequest(deps(), 'not json');
    assert({
      given: 'a send body that is not JSON',
      should: 'refuse with 400 rather than guessing a payload — stdin writes must never be reconstructed from a malformed request',
      actual: { status: result.status, error: result.body.error },
      expected: { status: 400, error: 'Invalid JSON' },
    });
  });
});

describe('handleShellReadRequest — liveness', () => {
  it('given a live session with no viewers attached, should report live with its scrollback tail', async () => {
    const session = sessionWithOutput('one\r\ntwo\r\n');
    const result = await handleShellReadRequest(deps({ 'k:sh': session }), readBody());
    assert({
      given: 'a running PTY nobody is currently watching',
      should: 'report it live — attachment is not existence',
      actual: result.body.shells,
      expected: [{ shellId: 'sh', live: true, hasOutput: true, viewers: 0, output: 'one\ntwo' }],
    });
  });

  it('given a live session that has never produced a byte, should report live with hasOutput false', async () => {
    const result = await handleShellReadRequest(deps({ 'k:sh': makeSession() }), readBody());
    assert({
      given: 'a live PTY that has produced nothing yet',
      should: 'report live with an honest hasOutput:false, not a cold answer',
      actual: result.body.shells,
      expected: [{ shellId: 'sh', live: true, hasOutput: false, viewers: 0, output: '' }],
    });
  });

  it('given a cold session (no live PTY at all), should report live:false rather than empty output', async () => {
    const result = await handleShellReadRequest(deps(), readBody());
    assert({
      given: 'a session with no PTY in the live map',
      should: 'answer live:false — never a fabricated empty scrollback',
      actual: result.body.shells,
      expected: [{ shellId: 'sh', live: false, hasOutput: false, viewers: 0, output: '' }],
    });
  });

  it('given several shellIds, should answer each independently in the order asked', async () => {
    const result = await handleShellReadRequest(
      deps({ 'k:b': sessionWithOutput('hi\r\n') }),
      readBody({ shellIds: ['a', 'b'] }),
    );
    assert({
      given: 'a mix of cold and live shells',
      should: 'report each one honestly, in order',
      actual: result.body.shells?.map((entry) => ({ shellId: entry.shellId, live: entry.live })),
      expected: [
        { shellId: 'a', live: false },
        { shellId: 'b', live: true },
      ],
    });
  });

  it('given limit 0, should answer liveness only (the list_sessions sweep) without any scrollback', async () => {
    const result = await handleShellReadRequest(
      deps({ 'k:sh': sessionWithOutput('secret\r\n') }),
      readBody({ limit: 0 }),
    );
    assert({
      given: 'a liveness-only query',
      should: 'report live without shipping any output',
      actual: result.body.shells,
      expected: [{ shellId: 'sh', live: true, hasOutput: true, viewers: 0, output: '' }],
    });
  });
});

describe('scrollbackTail', () => {
  it('given more lines than the limit, should keep the TAIL', () => {
    const session = sessionWithOutput('1\r\n2\r\n3\r\n4\r\n');
    assert({
      given: 'a ring holding more lines than asked for',
      should: 'return the most recent lines',
      actual: scrollbackTail(session, 2),
      expected: '3\n4',
    });
  });

  it('given chunks that split a line, should join them before splitting', () => {
    const session = makeSession();
    appendScrollback(session, 'he');
    appendScrollback(session, 'llo\r\nworld\r\n');
    assert({
      given: 'a line delivered across two PTY chunks',
      should: 'reassemble it rather than counting each chunk as a line',
      actual: scrollbackTail(session, 5),
      expected: 'hello\nworld',
    });
  });

  it('given ONE newline-free line larger than the byte cap, should keep only its TAIL bytes — the cap binds even when there is no line boundary to drop at', () => {
    // A command printing a giant single line (a minified bundle, a base64
    // blob) must not inflate the answer to the ring's full 64 KiB: the cap is
    // a per-ANSWER contract with the model's context window.
    const session = sessionWithOutput('x'.repeat(40_000));
    const tail = scrollbackTail(session, 5);
    assert({
      given: 'a single line wider than the byte cap',
      should: 'return at most the cap, keeping the most recent bytes',
      actual: {
        withinCap: Buffer.byteLength(tail, 'utf8') <= MAX_SCROLLBACK_TAIL_BYTES,
        keepsTheEnd: tail.endsWith('x'),
        marked: tail.startsWith('…'),
      },
      expected: { withinCap: true, keepsTheEnd: true, marked: true },
    });
  });

  it('given a tail larger than the byte cap, should drop whole leading lines until it fits', () => {
    const session = sessionWithOutput(`${'x'.repeat(4000)}\r\n`.repeat(8));
    const tail = scrollbackTail(session, 500);
    assert({
      given: 'a scrollback tail over the byte cap',
      should: 'fit under the cap on whole-line boundaries',
      actual: {
        withinCap: Buffer.byteLength(tail, 'utf8') <= MAX_SCROLLBACK_TAIL_BYTES,
        wholeLines: tail.split('\n').every((line) => line.length === 4000),
      },
      expected: { withinCap: true, wholeLines: true },
    });
  });
});

/** A session whose PTY records what was written to it, with viewers attached. */
function writableSession(): {
  session: TerminalSession;
  written: string[];
  seenByViewer: string[];
} {
  const written: string[] = [];
  const seenByViewer: string[] = [];
  const session = makeSession({
    command: { write: (data: string) => written.push(data) } as unknown as TerminalSession['command'],
    viewers: new Map([
      [
        'sockA conn-a',
        {
          userId: 'human',
          emitOutput: (data: string) => seenByViewer.push(data),
          emitClosed: () => {},
          emitError: () => {},
        },
      ],
    ]),
  });
  return { session, written, seenByViewer };
}

function sendBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ shellId: 'sh', input: 'ls\n', ...over });
}

describe('handleShellSendRequest', () => {
  it('given a live PTY, should write the input to it and bump lastInputAt', async () => {
    const { session, written } = writableSession();
    const result = await handleShellSendRequest(deps({ 'k:sh': session }), sendBody(), () => 1_700_000_000_000);

    assert({
      given: 'input for a running shell session',
      should: 'write it to the PTY and count it as activity',
      actual: { body: result.body, written, lastInputAt: session.lastInputAt },
      expected: {
        body: { success: true, live: true, delivered: true },
        written: ['ls\n'],
        lastInputAt: 1_700_000_000_000,
      },
    });
  });

  it('given a human viewer watching, should type into the SAME PTY they are attached to', async () => {
    const { session, written, seenByViewer } = writableSession();
    await handleShellSendRequest(deps({ 'k:sh': session }), sendBody());

    assert({
      given: 'a human attached to the session',
      should: 'go through the shared PTY — the shell echoes it back to every viewer, so nothing is injected into their feed here',
      actual: { written, injectedDirectlyIntoTheFeed: seenByViewer },
      expected: { written: ['ls\n'], injectedDirectlyIntoTheFeed: [] },
    });
  });

  it('given control characters, should deliver them VERBATIM as keys', async () => {
    const { session, written } = writableSession();
    await handleShellSendRequest(deps({ 'k:sh': session }), sendBody({ input: '\x03' }));

    assert({
      given: 'Ctrl-C',
      should: 'reach the PTY byte-for-byte — to a terminal a control character is a KEY, and interrupting a runaway process depends on it',
      actual: written,
      expected: ['\x03'],
    });
  });

  it('given no live PTY, should report live:false and deliver nothing', async () => {
    const result = await handleShellSendRequest(deps(), sendBody());

    assert({
      given: 'a session whose PTY is not running',
      should: 'say so rather than silently swallowing the keystrokes',
      actual: result.body,
      expected: { success: true, live: false, delivered: false },
    });
  });

  it('given an empty input, should refuse with 400 without touching the PTY', async () => {
    const { session, written } = writableSession();
    const result = await handleShellSendRequest(deps({ 'k:sh': session }), sendBody({ input: '' }));

    assert({
      given: 'a payload with nothing to type',
      should: 'refuse with 400',
      actual: { status: result.status, written },
      expected: { status: 400, written: [] },
    });
  });

  it('given input over the byte cap, should refuse with 400 without truncating it', async () => {
    const { session, written } = writableSession();
    const result = await handleShellSendRequest(
      deps({ 'k:sh': session }),
      sendBody({ input: 'x'.repeat(MAX_SHELL_INPUT_BYTES + 1) }),
    );

    assert({
      given: 'more input than one write may carry',
      should: 'refuse rather than type half a command',
      actual: { status: result.status, written },
      expected: { status: 400, written: [] },
    });
  });

  it('given no shellId, should refuse with 400', async () => {
    const result = await handleShellSendRequest(deps(), JSON.stringify({ input: 'ls' }));

    assert({
      given: 'a payload naming no shell',
      should: 'refuse with 400',
      actual: { status: result.status, error: result.body.error },
      expected: { status: 400, error: 'Missing or invalid shellId' },
    });
  });

  it('given a blank userId, should refuse with 400 naming userId — distinct from an absent one', async () => {
    // `userId` is optional on the wire (the liveness sweep sends neither), so
    // an ABSENT one passes the schema and is rejected later by
    // `planSessionStart`. A PRESENT but blank one is a shape violation the
    // schema itself refuses — the two paths report the same message through
    // different code, and this pins the schema-level one.
    const result = await handleShellSendRequest(deps(), sendBody({ userId: '' }));

    assert({
      given: 'a send whose userId is present but empty',
      should: 'refuse with 400 — a blank identity is not a usable one',
      actual: { status: result.status, error: result.body.error },
      expected: { status: 400, error: 'Missing or invalid userId' },
    });
  });

  it('given a payload that is not an object at all, should refuse with a generic 400', async () => {
    // An array passes the handler's own `typeof === 'object'` guard (arrays
    // ARE objects), so it reaches the zod schema, which reports a root-level
    // issue with an EMPTY path — none of the named fields, hence the
    // catch-all message.
    const result = await handleShellSendRequest(deps(), JSON.stringify([]));

    assert({
      given: 'a JSON array where an object was expected',
      should: 'refuse with 400 and the generic invalid-payload message',
      actual: { status: result.status, error: result.body.error },
      expected: { status: 400, error: 'Invalid payload' },
    });
  });
});

/**
 * Headless PTY start (issue #2206). A shell session is RESERVED until something
 * starts its PTY; before this, only a human opening the pane could. Now the
 * first agent read/send starts it — which makes the interesting questions
 * "when is a start attempted at all" and "what does the caller learn".
 */
describe('shell IO — headless start', () => {
  /** A start seam that succeeds, recording what it was asked to start. */
  function starter(session: TerminalSession) {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      startSession: async (address: Record<string, unknown>) => {
        calls.push(address);
        return session;
      },
    };
  }

  describe('handleShellSendRequest', () => {
    it('given a start that authorizes a NEW identity, should adopt it without a separate re-auth seam', async () => {
      // The start path re-decides authorization for this userId in the same
      // request (that is what `startSession` does), so no `reauthorizeViewer` is
      // needed to trust it — unlike a plain send, which has established nothing.
      const { session } = writableSession();
      session.viewers.clear();
      session.lastViewerUserId = 'creator';
      const start = starter(session);

      await handleShellSendRequest(
        { ...deps(), startSession: start.startSession },
        sendBody({ start: true, userId: 'starter-user' }),
      );

      assert({
        given: 'a send that STARTS the session for a different user',
        should: 'track that user, since the start itself authorized them',
        actual: session.lastViewerUserId,
        expected: 'starter-user',
      });
    });

    it('given input for a reserved session and a start seam, should start the PTY and deliver into it', async () => {
      const { session, written } = writableSession();
      const start = starter(session);
      const result = await handleShellSendRequest(
        { ...deps(), startSession: start.startSession },
        sendBody({ start: true, userId: 'user-1' }),
      );

      assert({
        given: 'a shell whose PTY has never run',
        should: 'boot it, type the input into it, and say so — rather than swallow a command that never ran',
        actual: { body: result.body, written, startedFor: start.calls },
        expected: {
          body: { success: true, live: true, delivered: true, started: true },
          written: ['ls\n'],
          startedFor: [{ shellId: 'sh', userId: 'user-1' }],
        },
      });
    });

    it('given a session already live, should NOT ask the starter — there is nothing to start', async () => {
      const { session, written } = writableSession();
      const start = starter(session);
      const result = await handleShellSendRequest(
        { ...deps({ 'k:sh': session }), startSession: start.startSession },
        sendBody({ start: true, userId: 'user-1' }),
      );

      assert({
        given: 'input for a PTY that is already running',
        should: 'write straight to it, with no start attempted and no `started` claimed',
        actual: { body: result.body, written, starts: start.calls.length },
        expected: { body: { success: true, live: true, delivered: true }, written: ['ls\n'], starts: 0 },
      });
    });

    it('given a start that refuses WITH a reason, should pass the reason to the caller', async () => {
      const result = await handleShellSendRequest(
        { ...deps(), startSession: async () => ({ reason: 'Live agent-session limit reached for your plan.' }) },
        sendBody({ start: true, userId: 'user-1' }),
      );

      assert({
        given: 'an agent that hit its plan ceiling',
        should: 'say so, so it can stop retrying a wall it will hit every time',
        actual: result.body,
        expected: {
          success: true,
          live: false,
          delivered: false,
          reason: 'Live agent-session limit reached for your plan.',
        },
      });
    });

    it('given a start that fails, should report nothing delivered rather than claim a live session', async () => {
      const result = await handleShellSendRequest(
        { ...deps(), startSession: async () => undefined },
        sendBody({ start: true, userId: 'user-1' }),
      );

      assert({
        given: 'a PTY that could not be started (no credits, no slot, sprite gone)',
        should: 'answer exactly as an unstartable session always has — nothing was typed',
        actual: result.body,
        expected: { success: true, live: false, delivered: false },
      });
    });

    it('given no start seam wired, should behave exactly as before', async () => {
      const result = await handleShellSendRequest(deps(), sendBody({ start: true, userId: 'user-1' }));

      assert({
        given: 'a deployment whose realtime service cannot start sessions',
        should: 'degrade to the honest not-live answer rather than throw',
        actual: result.body,
        expected: { success: true, live: false, delivered: false },
      });
    });

    it('given start requested without a userId, should refuse — a PTY is started FOR someone', async () => {
      const { session } = writableSession();
      const start = starter(session);
      const result = await handleShellSendRequest(
        { ...deps(), startSession: start.startSession },
        sendBody({ start: true }),
      );

      assert({
        given: 'a start with nobody to authorize, meter or attribute it to',
        should: 'refuse with 400 and start nothing',
        actual: { status: result.status, error: result.body.error, starts: start.calls.length },
        expected: { status: 400, error: 'Missing or invalid userId', starts: 0 },
      });
    });

    it('given no start requested, should not start even with the seam wired', async () => {
      const { session } = writableSession();
      const start = starter(session);
      const result = await handleShellSendRequest(
        { ...deps(), startSession: start.startSession },
        sendBody({ userId: 'user-1' }),
      );

      assert({
        given: 'a caller that did not ask for a start',
        should: 'leave the session reserved — starting one is opt-in, never inferred',
        actual: { body: result.body, starts: start.calls.length },
        expected: { body: { success: true, live: false, delivered: false }, starts: 0 },
      });
    });

    it('given a non-boolean start flag, should refuse with 400', async () => {
      const result = await handleShellSendRequest(deps(), sendBody({ start: 'yes', userId: 'user-1' }));

      assert({
        given: 'a start flag that is not a boolean',
        should: 'refuse rather than coerce a truthy string into starting a sandbox',
        actual: { status: result.status, error: result.body.error },
        expected: { status: 400, error: 'Invalid start' },
      });
    });

    it('given delivered input to a session nobody is watching, should push the reap back', async () => {
      // A headless session is created with its 30-minute reap already ticking. An
      // agent driving it at minute 29 must not have its command killed at minute 30.
      const { session } = writableSession();
      session.viewers.clear();
      const rearmed: TerminalSession[] = [];
      await handleShellSendRequest(
        { ...deps({ 'k:sh': session }), rearmIdleReap: (s: TerminalSession) => rearmed.push(s) },
        sendBody(),
      );

      assert({
        given: 'agent input into a viewer-less session',
        should: 're-arm the reap — this session is in use',
        actual: rearmed.length === 1 && rearmed[0] === session,
        expected: true,
      });
    });

    it('given a RE-AUTHORIZED different user, should become the tracked identity', async () => {
      // The detached re-auth tick checks ONLY `lastViewerUserId` while nobody
      // is attached — leaving it pinned to the creator while a different
      // authorized user goes on sending would let revoking the creator kill
      // work this user is still authorized to run, and revoking THIS user do
      // nothing at all. So it must refresh — but only for a user this request
      // established authorization for.
      const { session } = writableSession();
      session.viewers.clear();
      session.lastViewerUserId = 'user-1';
      await handleShellSendRequest(
        { ...deps({ 'k:sh': session }), reauthorizeViewer: async () => true },
        sendBody({ userId: 'user-2' }),
      );

      assert({
        given: 'a viewer-less session sent to by a different, re-authorized user',
        should: 'track the sender as the identity the re-auth tick checks',
        actual: session.lastViewerUserId,
        expected: 'user-2',
      });
    });

    it('given a different user who FAILS re-authorization, should leave the identity alone', async () => {
      const { session } = writableSession();
      session.viewers.clear();
      session.lastViewerUserId = 'user-1';
      await handleShellSendRequest(
        { ...deps({ 'k:sh': session }), reauthorizeViewer: async () => false },
        sendBody({ userId: 'attacker' }),
      );

      assert({
        given: 'a caller-supplied identity that does not re-authorize',
        should: 'keep the established identity so revocation still evicts the right user',
        actual: session.lastViewerUserId,
        expected: 'user-1',
      });
    });

    it('given NO re-auth seam wired, should fail closed rather than trust the caller-supplied identity', async () => {
      // The endpoint is HMAC-gated, but the signature says WHO IS CALLING, not
      // on whose behalf — a forged identity here would keep a revoked user's
      // session alive, which is strictly worse than a spurious eviction.
      const { session } = writableSession();
      session.viewers.clear();
      session.lastViewerUserId = 'user-1';
      await handleShellSendRequest(
        { ...deps({ 'k:sh': session }) },
        sendBody({ userId: 'user-2' }),
      );

      assert({
        given: 'no reauthorizeViewer dep and a different caller-supplied userId',
        should: 'leave the tracked identity untouched',
        actual: session.lastViewerUserId,
        expected: 'user-1',
      });
    });

    it('given delivered input with no userId at all, should leave the tracked identity alone', async () => {
      const { session } = writableSession();
      session.viewers.clear();
      session.lastViewerUserId = 'user-1';
      await handleShellSendRequest(
        { ...deps({ 'k:sh': session }) },
        sendBody(),
      );

      assert({
        given: 'a send with no userId in the payload',
        should: 'leave the existing tracked identity untouched rather than clearing it',
        actual: session.lastViewerUserId,
        expected: 'user-1',
      });
    });

    it('given delivered input to a session someone IS watching, should leave the reap alone', async () => {
      const { session } = writableSession();
      const rearmed: TerminalSession[] = [];
      await handleShellSendRequest(
        { ...deps({ 'k:sh': session }), rearmIdleReap: (s: TerminalSession) => rearmed.push(s) },
        sendBody(),
      );

      assert({
        given: 'a session with a viewer attached',
        should: 'not touch a reap that is not armed — the viewer leaving is what arms it',
        actual: rearmed.length,
        expected: 0,
      });
    });

    it('given the caller is still there, should pass the starter an abandoned() that reads false', async () => {
      const { session } = writableSession();
      const seenAbandoned: Array<() => boolean> = [];
      await handleShellSendRequest(
        {
          ...deps(),
          startSession: async (_address, abandoned) => {
            seenAbandoned.push(abandoned);
            return session;
          },
        },
        sendBody({ start: true, userId: 'user-1' }),
        undefined,
        () => false,
      );

      assert({
        given: 'a request whose caller is still connected',
        should: 'thread that liveness through to the starter, not swallow it',
        actual: seenAbandoned.length === 1 && seenAbandoned[0]() === false,
        expected: true,
      });
    });

    it('given the caller gave up mid-start, should not deliver — a retry must not run the input twice', async () => {
      // The web tier's own fetch times out before a cold Sprite wake can
      // finish; without this, the PTY would still get created and the input
      // still written after the caller had already been told nothing happened
      // — and a caller that retries on that timeout would run the command twice.
      // The starter itself is `ensureShellSession`, whose OWN
      // `abandoned()` check is what actually bails on a real start — here it
      // is stubbed to return `undefined` the way that check would, and the
      // point of the test is that this module hands it the real liveness.
      const { written } = writableSession();
      let receivedAbandoned: (() => boolean) | undefined;
      const result = await handleShellSendRequest(
        {
          ...deps(),
          startSession: async (_address, abandoned) => {
            receivedAbandoned = abandoned;
            return undefined;
          },
        },
        sendBody({ start: true, userId: 'user-1' }),
        undefined,
        () => true,
      );

      assert({
        given: 'a caller who abandoned the request before the cold start finished',
        should: 'hand the starter that same liveness, and report nothing delivered when it bails',
        actual: { body: result.body, written, sawAbandoned: receivedAbandoned?.() },
        expected: { body: { success: true, live: false, delivered: false }, written: [], sawAbandoned: true },
      });
    });
  });

  describe('handleShellReadRequest', () => {
    it('given a read of a reserved session, should start it and answer as the live, silent session it now is', async () => {
      const { session } = writableSession();
      const start = starter(session);
      const result = await handleShellReadRequest(
        { ...deps(), startSession: start.startSession },
        readBody({ start: true, userId: 'user-1' }),
      );

      assert({
        given: 'a read of a shell whose PTY has never run',
        should: 'boot it and report a live session that has produced nothing yet',
        actual: { body: result.body, starts: start.calls.length },
        expected: {
          body: {
            success: true,
            shells: [{ shellId: 'sh', live: true, hasOutput: false, viewers: 1, output: '', started: true }],
          },
          starts: 1,
        },
      });
    });

    it('given a start requested for MANY shellIds, should refuse — that shape is the liveness sweep', async () => {
      // the liveness sweep asks about every shell at a node at once. Starting on that
      // shape would boot a sandbox per row for a listing nobody asked to run.
      const { session } = writableSession();
      const start = starter(session);
      const result = await handleShellReadRequest(
        { ...deps(), startSession: start.startSession },
        readBody({ shellIds: ['sh', 'build'], start: true, userId: 'user-1' }),
      );

      assert({
        given: 'a multi-session read asking to start',
        should: 'refuse with 400 and start nothing',
        actual: { status: result.status, error: result.body.error, starts: start.calls.length },
        expected: { status: 400, error: 'Invalid start', starts: 0 },
      });
    });

    it('given the liveness sweep shape, should never start anything', async () => {
      const { session } = writableSession();
      const start = starter(session);
      const result = await handleShellReadRequest(
        { ...deps(), startSession: start.startSession },
        readBody({ shellIds: ['sh', 'build'], limit: 0 }),
      );

      assert({
        given: 'the sweep asking only whether sessions are live',
        should: 'answer not-live for both and start neither',
        actual: {
          live: (result.body.shells ?? []).map((entry) => entry.live),
          starts: start.calls.length,
        },
        expected: { live: [false, false], starts: 0 },
      });
    });

    it('given a read whose start refuses WITH a reason, should carry the reason on the entry', async () => {
      const result = await handleShellReadRequest(
        { ...deps(), startSession: async () => ({ reason: 'Live agent-session limit reached for your plan.' }) },
        readBody({ start: true, userId: 'user-1' }),
      );

      assert({
        given: 'a read that could not boot a PTY because the owner is at their ceiling',
        should: 'report the reason rather than an unexplained not-live',
        actual: result.body,
        expected: {
          success: true,
          shells: [{
            shellId: 'sh',
            live: false,
            hasOutput: false,
            viewers: 0,
            output: '',
            reason: 'Live agent-session limit reached for your plan.',
          }],
        },
      });
    });

    it('given a read whose start fails, should keep the never-started answer', async () => {
      const result = await handleShellReadRequest(
        { ...deps(), startSession: async () => undefined },
        readBody({ start: true, userId: 'user-1' }),
      );

      assert({
        given: 'a read of a session that could not be started',
        should: 'report it not live rather than an empty scrollback that reads as silence',
        actual: result.body,
        expected: { success: true, shells: [{ shellId: 'sh', live: false, hasOutput: false, viewers: 0, output: '' }] },
      });
    });

    it('given the caller gave up mid-start, should keep the never-started answer and start nothing', async () => {
      let receivedAbandoned: (() => boolean) | undefined;
      const result = await handleShellReadRequest(
        {
          ...deps(),
          startSession: async (_address, abandoned) => {
            receivedAbandoned = abandoned;
            return undefined;
          },
        },
        readBody({ start: true, userId: 'user-1' }),
        () => true,
      );

      assert({
        given: 'a caller who abandoned the request before a cold start could finish',
        should: 'hand the starter that same liveness, and answer as an unstartable session always has',
        actual: { body: result.body, sawAbandoned: receivedAbandoned?.() },
        expected: {
          body: { success: true, shells: [{ shellId: 'sh', live: false, hasOutput: false, viewers: 0, output: '' }] },
          sawAbandoned: true,
        },
      });
    });

    // Reading a build's output every so often is as real a use of a headless
    // session as typing into it — see `armIdleReap`'s doc. Without this, an
    // agent that starts a long build once and only ever polls `read_session`
    // (never `send_session` again) would have its build killed at the
    // 30-minute mark regardless of how often it was checked on.
    it('given a deliberate read of an already-live session nobody is watching, should push the reap back', async () => {
      const { session } = writableSession();
      session.viewers.clear();
      const rearmed: TerminalSession[] = [];
      await handleShellReadRequest(
        { ...deps({ 'k:sh': session }), rearmIdleReap: (s: TerminalSession) => rearmed.push(s) },
        readBody({ shellIds: ['sh'], start: true, userId: 'user-1' }),
      );

      assert({
        given: 'an agent polling a headless session nobody is watching',
        should: 're-arm the reap on every read, not only the one that boots it',
        actual: rearmed.length === 1 && rearmed[0] === session,
        expected: true,
      });
    });

    it('given a deliberate read from a DIFFERENT, RE-AUTHORIZED user, should become the tracked identity', async () => {
      const { session } = writableSession();
      session.viewers.clear();
      session.lastViewerUserId = 'user-1';
      await handleShellReadRequest(
        { ...deps({ 'k:sh': session }), reauthorizeViewer: async () => true },
        readBody({ shellIds: ['sh'], start: true, userId: 'user-2' }),
      );

      assert({
        given: 'a viewer-less session read by another user who re-authorizes',
        should: 'track the reader as the identity the detached re-auth tick checks',
        actual: session.lastViewerUserId,
        expected: 'user-2',
      });
    });

    it('given a deliberate read of a session someone IS watching, should leave the reap alone', async () => {
      const { session } = writableSession();
      const rearmed: TerminalSession[] = [];
      await handleShellReadRequest(
        { ...deps({ 'k:sh': session }), rearmIdleReap: (s: TerminalSession) => rearmed.push(s) },
        readBody({ shellIds: ['sh'], start: true, userId: 'user-1' }),
      );

      assert({
        given: 'a session with a viewer attached',
        should: 'not touch a reap that is not armed',
        actual: rearmed.length,
        expected: 0,
      });
    });

    it('given the liveness sweep shape, should never rearm even when a named session has no viewers', async () => {
      // The sweep never sets `start` — that is the ENTIRE signal this rearm
      // decision is gated on. Without it, the liveness sweep housekeeping would
      // perpetually push back the reap of every headless shell at a node,
      // defeating idle reaping outright.
      const { session } = writableSession();
      session.viewers.clear();
      const rearmed: TerminalSession[] = [];
      await handleShellReadRequest(
        { ...deps({ 'k:sh': session }), rearmIdleReap: (s: TerminalSession) => rearmed.push(s) },
        readBody({ shellIds: ['sh'], limit: 0 }),
      );

      assert({
        given: 'the liveness sweep reading a viewer-less session',
        should: 'start nothing and rearm nothing — this is housekeeping, not use',
        actual: rearmed.length,
        expected: 0,
      });
    });
  });
});

describe('planSessionStart', () => {
  it('given a malformed userId, should refuse even when no start was asked for', () => {
    // Validated on its own terms rather than only inside the start branch: a
    // field this endpoint uses to decide WHO a sandbox is billed to must never
    // reach the seam as an empty string.
    assert({
      given: 'a payload carrying a userId that is not a usable identity',
      should: 'refuse the request',
      actual: planSessionStart({ userId: '' }, { addressable: true, hasStarter: true }),
      expected: { ok: false, error: 'Missing or invalid userId' },
    });
  });
});

/**
 * The read path shares the send path's trust boundary: `start: true` on an
 * already-live session lets a caller propose a new tracked identity, so an
 * ungated read would make the send-path re-auth bypassable by asking to READ.
 */
describe('handleShellReadRequest — viewer identity re-authorization', () => {
  it('given a re-authorized reader, should adopt them as the tracked identity', async () => {
    const { session } = writableSession();
    session.viewers.clear();
    session.lastViewerUserId = 'user-1';

    await handleShellReadRequest(
      { ...deps({ 'k:sh': session }), reauthorizeViewer: async () => true },
      JSON.stringify({ shellIds: ['sh'], start: true, userId: 'user-2' }),
    );

    expect(session.lastViewerUserId).toBe('user-2');
  });

  it('given a reader who fails re-authorization, should keep the established identity', async () => {
    const { session } = writableSession();
    session.viewers.clear();
    session.lastViewerUserId = 'user-1';

    await handleShellReadRequest(
      { ...deps({ 'k:sh': session }), reauthorizeViewer: async () => false },
      JSON.stringify({ shellIds: ['sh'], start: true, userId: 'attacker' }),
    );

    expect(session.lastViewerUserId).toBe('user-1');
  });

  it('given NO re-auth seam, should fail closed rather than trust the caller', async () => {
    const { session } = writableSession();
    session.viewers.clear();
    session.lastViewerUserId = 'user-1';

    await handleShellReadRequest(
      { ...deps({ 'k:sh': session }) },
      JSON.stringify({ shellIds: ['sh'], start: true, userId: 'user-2' }),
    );

    expect(session.lastViewerUserId).toBe('user-1');
  });
});

/**
 * The re-auth check runs AFTER the input has already been written to the PTY on
 * the send path. If it rejects, the request 500s for a command that already ran
 * — and a caller reading 500 as "nothing happened" retries, double-executing it.
 */
describe('reauthorizeViewer failure handling', () => {
  it('given the re-auth check THROWS, should not reject the request', async () => {
    const { session, written } = writableSession();
    session.viewers.clear();
    session.lastViewerUserId = 'user-1';

    const result = await handleShellSendRequest(
      {
        ...deps({ 'k:sh': session }),
        reauthorizeViewer: async () => { throw new Error('db blip'); },
      },
      sendBody({ userId: 'user-2' }),
    );

    // The write happened and the caller gets a normal answer — no 500, so no
    // retry, so no double execution.
    expect(result.status).toBe(200);
    expect(written).toEqual(['ls\n']);
    // Fails closed: the identity is left alone rather than trusted.
    expect(session.lastViewerUserId).toBe('user-1');
  });

  it('given the re-auth check throws on the READ path, should still answer', async () => {
    const { session } = writableSession();
    session.viewers.clear();
    session.lastViewerUserId = 'user-1';

    const result = await handleShellReadRequest(
      {
        ...deps({ 'k:sh': session }),
        reauthorizeViewer: async () => { throw new Error('db blip'); },
      },
      JSON.stringify({ shellIds: ['sh'], start: true, userId: 'user-2' }),
    );

    expect(result.status).toBe(200);
    expect(session.lastViewerUserId).toBe('user-1');
  });
});
