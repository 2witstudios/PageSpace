import { describe, it } from 'vitest';
import { assert } from './riteway';
import {
  handleSessionReadRequest,
  handleSessionSendRequest,
  MAX_SESSION_INPUT_BYTES,
  scrollbackTail,
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
