import { describe, it } from 'vitest';
import { assert } from './riteway';
import {
  handleSessionReadRequest,
  handleSessionSendRequest,
  MAX_SESSION_INPUT_BYTES,
  scrollbackTail,
  planSessionStart,
  MAX_SCROLLBACK_TAIL_BYTES,
  type SessionIoDeps,
} from '../session-io';
import { appendScrollback, type TerminalSession } from '../terminal-session-map';

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

function deps(sessions: Record<string, TerminalSession> = {}): SessionIoDeps {
  return {
    sessionMap: { getByKey: (key: string) => sessions[key] },
    // The pure key derivation the socket handler uses, stubbed to the same
    // shape: (node names + session name) in, one opaque string out.
    sessionKeyFor: ({ machineId, projectName, branchName, name }) =>
      [machineId, projectName ?? '-', branchName ?? '-', name].join('|'),
  };
}

function readBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ machineId: 'm1', names: ['sh'], ...over });
}

describe('handleSessionReadRequest — validation', () => {
  it('given invalid JSON, should refuse with 400', async () => {
    const result = await handleSessionReadRequest(deps(), 'not json');
    assert({
      given: 'a body that is not JSON',
      should: 'refuse with 400 rather than guessing a payload',
      actual: result.status,
      expected: 400,
    });
  });

  it('given no machineId, should refuse with 400', async () => {
    const result = await handleSessionReadRequest(deps(), JSON.stringify({ names: ['sh'] }));
    assert({
      given: 'a payload with no machineId',
      should: 'refuse with 400',
      actual: { status: result.status, error: result.body.error },
      expected: { status: 400, error: 'Missing or invalid machineId' },
    });
  });

  it('given an empty names list, should refuse with 400', async () => {
    const result = await handleSessionReadRequest(deps(), readBody({ names: [] }));
    assert({
      given: 'a payload naming no sessions',
      should: 'refuse with 400',
      actual: { status: result.status, error: result.body.error },
      expected: { status: 400, error: 'Missing or invalid names' },
    });
  });

  it('given a non-integer or negative limit, should refuse with 400', async () => {
    const negative = await handleSessionReadRequest(deps(), readBody({ limit: -1 }));
    const fractional = await handleSessionReadRequest(deps(), readBody({ limit: 1.5 }));
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
});

describe('handleSessionSendRequest — validation', () => {
  it('given invalid JSON, should refuse with 400', async () => {
    const result = await handleSessionSendRequest(deps(), 'not json');
    assert({
      given: 'a send body that is not JSON',
      should: 'refuse with 400 rather than guessing a payload — stdin writes must never be reconstructed from a malformed request',
      actual: { status: result.status, error: result.body.error },
      expected: { status: 400, error: 'Invalid JSON' },
    });
  });
});

describe('handleSessionReadRequest — liveness', () => {
  it('given a live session with no viewers attached, should report live with its scrollback tail', async () => {
    const session = sessionWithOutput('one\r\ntwo\r\n');
    const result = await handleSessionReadRequest(deps({ 'm1|-|-|sh': session }), readBody());
    assert({
      given: 'a running PTY nobody is currently watching',
      should: 'report it live — attachment is not existence',
      actual: result.body.sessions,
      expected: [{ name: 'sh', live: true, hasOutput: true, viewers: 0, output: 'one\ntwo' }],
    });
  });

  it('given a live session that has never produced a byte, should report live with hasOutput false', async () => {
    const result = await handleSessionReadRequest(deps({ 'm1|-|-|sh': makeSession() }), readBody());
    assert({
      given: 'a live PTY that has produced nothing yet',
      should: 'report live with an honest hasOutput:false, not a cold answer',
      actual: result.body.sessions,
      expected: [{ name: 'sh', live: true, hasOutput: false, viewers: 0, output: '' }],
    });
  });

  it('given a cold session (no live PTY at all), should report live:false rather than empty output', async () => {
    const result = await handleSessionReadRequest(deps(), readBody());
    assert({
      given: 'a session with no PTY in the live map',
      should: 'answer live:false — never a fabricated empty scrollback',
      actual: result.body.sessions,
      expected: [{ name: 'sh', live: false, hasOutput: false, viewers: 0, output: '' }],
    });
  });

  it('given several names, should answer each independently in the order asked', async () => {
    const result = await handleSessionReadRequest(
      deps({ 'm1|proj|br|b': sessionWithOutput('hi\r\n') }),
      readBody({ projectName: 'proj', branchName: 'br', names: ['a', 'b'] }),
    );
    assert({
      given: 'a mix of cold and live sessions at a branch node',
      should: 'report each one honestly, in order',
      actual: result.body.sessions?.map((entry) => ({ name: entry.name, live: entry.live })),
      expected: [
        { name: 'a', live: false },
        { name: 'b', live: true },
      ],
    });
  });

  it('given limit 0, should answer liveness only (the list_sessions sweep) without any scrollback', async () => {
    const result = await handleSessionReadRequest(
      deps({ 'm1|-|-|sh': sessionWithOutput('secret\r\n') }),
      readBody({ limit: 0 }),
    );
    assert({
      given: 'a liveness-only query',
      should: 'report live without shipping any output',
      actual: result.body.sessions,
      expected: [{ name: 'sh', live: true, hasOutput: true, viewers: 0, output: '' }],
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
  return JSON.stringify({ machineId: 'm1', name: 'sh', input: 'ls\n', ...over });
}

describe('handleSessionSendRequest', () => {
  it('given a live PTY, should write the input to it and bump lastInputAt', async () => {
    const { session, written } = writableSession();
    const result = await handleSessionSendRequest(deps({ 'm1|-|-|sh': session }), sendBody(), () => 1_700_000_000_000);

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
    await handleSessionSendRequest(deps({ 'm1|-|-|sh': session }), sendBody());

    assert({
      given: 'a human attached to the session',
      should: 'go through the shared PTY — the shell echoes it back to every viewer, so nothing is injected into their feed here',
      actual: { written, injectedDirectlyIntoTheFeed: seenByViewer },
      expected: { written: ['ls\n'], injectedDirectlyIntoTheFeed: [] },
    });
  });

  it('given control characters, should deliver them VERBATIM as keys', async () => {
    const { session, written } = writableSession();
    await handleSessionSendRequest(deps({ 'm1|-|-|sh': session }), sendBody({ input: '\x03' }));

    assert({
      given: 'Ctrl-C',
      should: 'reach the PTY byte-for-byte — to a terminal a control character is a KEY, and interrupting a runaway process depends on it',
      actual: written,
      expected: ['\x03'],
    });
  });

  it('given no live PTY, should report live:false and deliver nothing', async () => {
    const result = await handleSessionSendRequest(deps(), sendBody());

    assert({
      given: 'a session whose PTY is not running',
      should: 'say so rather than silently swallowing the keystrokes',
      actual: result.body,
      expected: { success: true, live: false, delivered: false },
    });
  });

  it('given an empty input, should refuse with 400 without touching the PTY', async () => {
    const { session, written } = writableSession();
    const result = await handleSessionSendRequest(deps({ 'm1|-|-|sh': session }), sendBody({ input: '' }));

    assert({
      given: 'a payload with nothing to type',
      should: 'refuse with 400',
      actual: { status: result.status, written },
      expected: { status: 400, written: [] },
    });
  });

  it('given input over the byte cap, should refuse with 400 without truncating it', async () => {
    const { session, written } = writableSession();
    const result = await handleSessionSendRequest(
      deps({ 'm1|-|-|sh': session }),
      sendBody({ input: 'x'.repeat(MAX_SESSION_INPUT_BYTES + 1) }),
    );

    assert({
      given: 'more input than one write may carry',
      should: 'refuse rather than type half a command',
      actual: { status: result.status, written },
      expected: { status: 400, written: [] },
    });
  });

  it('given no name, should refuse with 400', async () => {
    const result = await handleSessionSendRequest(deps(), JSON.stringify({ machineId: 'm1', input: 'ls' }));

    assert({
      given: 'a payload naming no session',
      should: 'refuse with 400',
      actual: { status: result.status, error: result.body.error },
      expected: { status: 400, error: 'Missing or invalid name' },
    });
  });
});

/**
 * Headless PTY start (issue #2206). A shell session is RESERVED until something
 * starts its PTY; before this, only a human opening the pane could. Now the
 * first agent read/send starts it — which makes the interesting questions
 * "when is a start attempted at all" and "what does the caller learn".
 */
describe('session IO — headless start', () => {
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

  describe('handleSessionSendRequest', () => {
    it('given input for a reserved session and a start seam, should start the PTY and deliver into it', async () => {
      const { session, written } = writableSession();
      const start = starter(session);
      const result = await handleSessionSendRequest(
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
          startedFor: [{ machineId: 'm1', name: 'sh', userId: 'user-1' }],
        },
      });
    });

    it('given a session already live, should NOT ask the starter — there is nothing to start', async () => {
      const { session, written } = writableSession();
      const start = starter(session);
      const result = await handleSessionSendRequest(
        { ...deps({ 'm1|-|-|sh': session }), startSession: start.startSession },
        sendBody({ start: true, userId: 'user-1' }),
      );

      assert({
        given: 'input for a PTY that is already running',
        should: 'write straight to it, with no start attempted and no `started` claimed',
        actual: { body: result.body, written, starts: start.calls.length },
        expected: { body: { success: true, live: true, delivered: true }, written: ['ls\n'], starts: 0 },
      });
    });

    it('given a start that fails, should report nothing delivered rather than claim a live session', async () => {
      const result = await handleSessionSendRequest(
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
      const result = await handleSessionSendRequest(deps(), sendBody({ start: true, userId: 'user-1' }));

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
      const result = await handleSessionSendRequest(
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
      const result = await handleSessionSendRequest(
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
      const result = await handleSessionSendRequest(deps(), sendBody({ start: 'yes', userId: 'user-1' }));

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
      await handleSessionSendRequest(
        { ...deps({ 'm1|-|-|sh': session }), rearmIdleReap: (s: TerminalSession) => rearmed.push(s) },
        sendBody(),
      );

      assert({
        given: 'agent input into a viewer-less session',
        should: 're-arm the reap — this session is in use',
        actual: rearmed.length === 1 && rearmed[0] === session,
        expected: true,
      });
    });

    it('given delivered input to a session someone IS watching, should leave the reap alone', async () => {
      const { session } = writableSession();
      const rearmed: TerminalSession[] = [];
      await handleSessionSendRequest(
        { ...deps({ 'm1|-|-|sh': session }), rearmIdleReap: (s: TerminalSession) => rearmed.push(s) },
        sendBody(),
      );

      assert({
        given: 'a session with a viewer attached',
        should: 'not touch a reap that is not armed — the viewer leaving is what arms it',
        actual: rearmed.length,
        expected: 0,
      });
    });
  });

  describe('handleSessionReadRequest', () => {
    it('given a read of a reserved session, should start it and answer as the live, silent session it now is', async () => {
      const { session } = writableSession();
      const start = starter(session);
      const result = await handleSessionReadRequest(
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
            sessions: [{ name: 'sh', live: true, hasOutput: false, viewers: 1, output: '', started: true }],
          },
          starts: 1,
        },
      });
    });

    it('given a start requested for MANY names, should refuse — that shape is the liveness sweep', async () => {
      // `list_sessions` asks about every shell at a node at once. Starting on that
      // shape would boot a sandbox per row for a listing nobody asked to run.
      const { session } = writableSession();
      const start = starter(session);
      const result = await handleSessionReadRequest(
        { ...deps(), startSession: start.startSession },
        readBody({ names: ['sh', 'build'], start: true, userId: 'user-1' }),
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
      const result = await handleSessionReadRequest(
        { ...deps(), startSession: start.startSession },
        readBody({ names: ['sh', 'build'], limit: 0 }),
      );

      assert({
        given: 'the sweep asking only whether sessions are live',
        should: 'answer not-live for both and start neither',
        actual: {
          live: (result.body.sessions ?? []).map((entry) => entry.live),
          starts: start.calls.length,
        },
        expected: { live: [false, false], starts: 0 },
      });
    });

    it('given a read whose start fails, should keep the never-started answer', async () => {
      const result = await handleSessionReadRequest(
        { ...deps(), startSession: async () => undefined },
        readBody({ start: true, userId: 'user-1' }),
      );

      assert({
        given: 'a read of a session that could not be started',
        should: 'report it not live rather than an empty scrollback that reads as silence',
        actual: result.body,
        expected: { success: true, sessions: [{ name: 'sh', live: false, hasOutput: false, viewers: 0, output: '' }] },
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
