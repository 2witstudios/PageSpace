import { describe, test, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { assert } from '@/stores/__tests__/riteway';
import type { Socket } from 'socket.io-client';

// xterm is a DOM/canvas library the pane imports dynamically; stub it so what's
// under test is the PROTOCOL this component speaks over the socket.
const written: string[] = [];
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    onData() {
      return { dispose: () => {} };
    }
    loadAddon() {}
    open() {}
    write(data: string) {
      written.push(data);
    }
    writeln(data: string) {
      written.push(data);
    }
    dispose() {}
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate() {}
    fit() {}
    dispose() {}
  },
}));
vi.mock('@/hooks/useXtermTheme', () => ({ useXtermTheme: () => ({}) }));
vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: { getState: () => ({ startEditing: vi.fn(), endEditing: vi.fn() }) },
}));

import XtermTerminal from './XtermTerminal';

/** A socket that records emits and lets a test drive the server's events. */
function fakeSocket() {
  // A SET of handlers per event, and a working `off` — every pane in the grid
  // registers on this one socket, so a Map of one handler per event could never
  // hold two panes at once, and a no-op `off` could never catch a teardown that
  // failed to unregister. Both are the machinery the prompt latches rest on.
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return {
    socket: {
      on: (event: string, handler: (payload: unknown) => void) => {
        const set = handlers.get(event) ?? new Set();
        set.add(handler);
        handlers.set(event, set);
      },
      off: (event: string, handler: (payload: unknown) => void) => {
        handlers.get(event)?.delete(handler);
      },
      emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }),
    } as unknown as Socket,
    emitted,
    /** The connectionIds the mounted panes announced — every event is tagged with one. */
    connectionIds: () =>
      emitted
        .filter((entry) => entry.event === 'agent-terminal:connect')
        .map((entry) => entry.payload.connectionId as string),
    connectionId: () => emitted.find((entry) => entry.event === 'agent-terminal:connect')?.payload.connectionId,
    server: (event: string, payload: Record<string, unknown>) =>
      handlers.get(event)?.forEach((handler) => handler(payload)),
    listenerCount: (event: string) => handlers.get(event)?.size ?? 0,
    hasHandlers: () => handlers.size > 0,
  };
}

const CONNECT = { machineId: 'm1', name: 'claude-a1b2c3' };

const inputs = (emitted: Array<{ event: string; payload: Record<string, unknown> }>) =>
  emitted.filter((entry) => entry.event === 'agent-terminal:input').map((entry) => entry.payload.data);

describe('XtermTerminal — starting-prompt delivery', () => {
  beforeEach(() => {
    written.length = 0;
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('a cold agent gets its prompt once it is up and drawing — not the instant it is exec’d', async () => {
    const fake = fakeSocket();
    const onSent = vi.fn();
    render(
      <XtermTerminal
        socket={fake.socket}
        sessionId="s1"
        connectPayload={CONNECT}
        initialInput="fix the build"
        onInitialInputSent={onSent}
      />
    );
    await waitFor(() => expect(fake.hasHandlers()).toBe(true));
    const connectionId = fake.connectionId();

    // A COLD start: the bridge emits ready with no scrollback the moment the
    // binary is exec'd — which is not yet when a raw-mode TUI reads stdin.
    fake.server('agent-terminal:ready', { connectionId });
    const beforeOutput = inputs(fake.emitted);

    // The agent prints its banner: it is alive and reading.
    fake.server('agent-terminal:output', { data: 'claude> ', connectionId });

    assert({
      given: 'a cold agent that has just been exec’d, then starts drawing',
      should: 'hold the prompt until the agent is demonstrably up, then type it and submit it once',
      actual: {
        atReady: beforeOutput,
        afterFirstOutput: inputs(fake.emitted),
        prompotSpent: onSent.mock.calls.length,
      },
      expected: {
        atReady: [],
        afterFirstOutput: ['fix the build', '\r'],
        prompotSpent: 1,
      },
    });
  });

  test('an agent that boots silently still gets its prompt, via the backstop', async () => {
    const fake = fakeSocket();
    render(
      <XtermTerminal socket={fake.socket} sessionId="s1" connectPayload={CONNECT} initialInput="fix the build" />
    );
    await waitFor(() => expect(fake.hasHandlers()).toBe(true));

    fake.server('agent-terminal:ready', { connectionId: fake.connectionId() });
    await vi.advanceTimersByTimeAsync(5000);

    assert({
      given: 'a cold agent that prints nothing at all on boot',
      should: 'still deliver the prompt once the backstop elapses — waiting on first output alone would hang forever',
      actual: inputs(fake.emitted),
      expected: ['fix the build', '\r'],
    });
  });

  test('an agent the bridge RESUMED is never typed at, even though the connect looks cold', async () => {
    const fake = fakeSocket();
    const onSent = vi.fn();
    render(
      <XtermTerminal
        socket={fake.socket}
        sessionId="s1"
        connectPayload={CONNECT}
        initialInput="fix the build"
        onInitialInputSent={onSent}
      />
    );
    await waitFor(() => expect(fake.hasHandlers()).toBe(true));
    const connectionId = fake.connectionId();

    // After a realtime restart the in-memory session map is empty, so connecting
    // to an agent that has been running for hours takes the bridge's CREATE path:
    // no scrollback, exactly like a cold boot. Only `resumed` tells them apart.
    fake.server('agent-terminal:ready', { resumed: true, connectionId });
    fake.server('agent-terminal:output', { data: 'y/n? ', connectionId });
    await vi.advanceTimersByTimeAsync(5000);

    assert({
      given: 'a connect the bridge served by resuming an agent that was already running',
      should:
        'write nothing and spend the prompt — this is the case the client CANNOT infer, and delivering here drops a line + CR into a live agent sitting at a confirmation',
      actual: { typed: inputs(fake.emitted), promptDropped: onSent.mock.calls.length },
      expected: { typed: [], promptDropped: 1 },
    });
  });

  test('a re-mount onto a still-silent booting agent DOES deliver — StrictMode must not eat the prompt', async () => {
    const fake = fakeSocket();
    render(
      <XtermTerminal socket={fake.socket} sessionId="s1" connectPayload={CONNECT} initialInput="fix the build" />
    );
    await waitFor(() => expect(fake.hasHandlers()).toBe(true));
    const connectionId = fake.connectionId();

    // A reattach to a PTY that has emitted NOTHING: the boot this pane is waiting
    // for, reached through a re-mount. React StrictMode does exactly this in dev,
    // so treating every reattach as unsafe would mean the prompt never worked
    // while developing the feature.
    fake.server('agent-terminal:ready', { scrollback: '', resumed: false, connectionId });
    fake.server('agent-terminal:output', { data: 'claude> ', connectionId });

    assert({
      given: 'a re-mount that reattaches to an agent which has printed nothing yet',
      should: 'still deliver the prompt — an agent that has emitted zero bytes cannot be sitting mid-confirmation',
      actual: inputs(fake.emitted),
      expected: ['fix the build', '\r'],
    });
  });

  test('a REATTACHED agent that has already printed is never typed at', async () => {
    const fake = fakeSocket();
    const onSent = vi.fn();
    render(
      <XtermTerminal
        socket={fake.socket}
        sessionId="s1"
        connectPayload={CONNECT}
        initialInput="fix the build"
        onInitialInputSent={onSent}
      />
    );
    await waitFor(() => expect(fake.hasHandlers()).toBe(true));
    const connectionId = fake.connectionId();

    // A REATTACH: ready carries scrollback, so this PTY was running before this
    // pane connected — the prompt belongs to a boot that already happened.
    fake.server('agent-terminal:ready', { scrollback: '$ ls\nREADME.md\n', connectionId });
    fake.server('agent-terminal:output', { data: 'y/n? ', connectionId });
    await vi.advanceTimersByTimeAsync(5000);

    assert({
      given: 'a pane reattaching to an agent that has been running (a reload, a workspace switch, days later)',
      should:
        'write NOTHING into it and spend the prompt anyway — typing a line + CR into a live agent sitting at a y/n confirmation is destructive, and the prompt must not survive to try again',
      actual: { typed: inputs(fake.emitted), promptDropped: onSent.mock.calls.length },
      expected: { typed: [], promptDropped: 1 },
    });
  });

  test('a prompt is delivered at most once, however many ready/output events arrive', async () => {
    const fake = fakeSocket();
    render(
      <XtermTerminal socket={fake.socket} sessionId="s1" connectPayload={CONNECT} initialInput="fix the build" />
    );
    await waitFor(() => expect(fake.hasHandlers()).toBe(true));
    const connectionId = fake.connectionId();

    fake.server('agent-terminal:ready', { connectionId });
    fake.server('agent-terminal:output', { data: 'a', connectionId });
    fake.server('agent-terminal:output', { data: 'b', connectionId });
    fake.server('agent-terminal:ready', { connectionId });
    await vi.advanceTimersByTimeAsync(5000);

    assert({
      given: 'repeated output, and a ready replayed by a socket reconnect',
      should: 'type the prompt exactly once — the latch, not luck, is what stops a second delivery',
      actual: inputs(fake.emitted),
      expected: ['fix the build', '\r'],
    });
  });

  test('an event for ANOTHER pane on the shared socket is ignored', async () => {
    const fake = fakeSocket();
    render(
      <XtermTerminal socket={fake.socket} sessionId="s1" connectPayload={CONNECT} initialInput="fix the build" />
    );
    await waitFor(() => expect(fake.hasHandlers()).toBe(true));

    // Every pane in the grid shares one socket, so it sees its siblings' events.
    fake.server('agent-terminal:ready', { connectionId: 'another-pane' });
    fake.server('agent-terminal:output', { data: 'not mine', connectionId: 'another-pane' });
    await vi.advanceTimersByTimeAsync(5000);

    assert({
      given: "a sibling pane's ready and output arriving on the shared socket",
      should: 'ignore them — the prompt must not be typed into a terminal it does not belong to',
      actual: { typed: inputs(fake.emitted), rendered: written },
      expected: { typed: [], rendered: [] },
    });
  });

  test('a pane with no starting prompt types nothing', async () => {
    const fake = fakeSocket();
    render(<XtermTerminal socket={fake.socket} sessionId="s1" connectPayload={CONNECT} />);
    await waitFor(() => expect(fake.hasHandlers()).toBe(true));

    fake.server('agent-terminal:ready', { connectionId: fake.connectionId() });
    fake.server('agent-terminal:output', { data: 'claude> ', connectionId: fake.connectionId() });
    await vi.advanceTimersByTimeAsync(5000);

    assert({
      given: 'a session opened with no starting prompt (the field is optional)',
      should: 'write nothing into the PTY — not even a bare submit',
      actual: inputs(fake.emitted),
      expected: [],
    });
  });

  test('a pane unmounted mid-boot types nothing more, and does NOT spend the prompt', async () => {
    const fake = fakeSocket();
    const onSent = vi.fn();
    const { unmount } = render(
      <XtermTerminal
        socket={fake.socket}
        sessionId="s1"
        connectPayload={CONNECT}
        initialInput="fix the build"
        onInitialInputSent={onSent}
      />
    );
    await waitFor(() => expect(fake.hasHandlers()).toBe(true));

    fake.server('agent-terminal:ready', { connectionId: fake.connectionId() });
    unmount();
    await vi.advanceTimersByTimeAsync(5000);

    assert({
      given: 'a pane closed (or a workspace switched away from) while its agent was still booting',
      should:
        'cancel the pending write but KEEP the prompt — spending it here would kill the re-mount path (StrictMode does exactly this in dev). Whether the next connect may deliver it is decided there, from resumed/scrollback',
      actual: { typed: inputs(fake.emitted), promptSpent: onSent.mock.calls.length, listeners: fake.listenerCount('agent-terminal:output') },
      expected: { typed: [], promptSpent: 0, listeners: 0 },
    });
  });

  test('output arriving BEFORE ready does not get typed at — the prompt waits to learn what it is talking to', async () => {
    const fake = fakeSocket();
    render(
      <XtermTerminal socket={fake.socket} sessionId="s1" connectPayload={CONNECT} initialInput="fix the build" />
    );
    await waitFor(() => expect(fake.hasHandlers()).toBe(true));
    const connectionId = fake.connectionId();

    // The server does work between opening the shell and announcing it, so the
    // agent's output can reach us first. `ready` is what carries `resumed` — until
    // it lands we do not know whether this agent has been running for hours.
    fake.server('agent-terminal:output', { data: 'y/n? ', connectionId });
    const beforeReady = inputs(fake.emitted);

    fake.server('agent-terminal:ready', { resumed: true, connectionId });
    await vi.advanceTimersByTimeAsync(5000);

    assert({
      given: 'a resumed agent whose output beat its ready to the client',
      should:
        'type NOTHING — delivering on first output alone would type into an agent whose state we had not been told yet, which is the whole hazard `resumed` exists to prevent',
      actual: { beforeReady, afterReady: inputs(fake.emitted) },
      expected: { beforeReady: [], afterReady: [] },
    });
  });

  test('a FRESH agent whose output beat its ready is prompted as soon as ready lands', async () => {
    const fake = fakeSocket();
    render(
      <XtermTerminal socket={fake.socket} sessionId="s1" connectPayload={CONNECT} initialInput="fix the build" />
    );
    await waitFor(() => expect(fake.hasHandlers()).toBe(true));
    const connectionId = fake.connectionId();

    fake.server('agent-terminal:output', { data: 'claude> ', connectionId });
    fake.server('agent-terminal:ready', { resumed: false, connectionId });

    assert({
      given: 'a cold boot that started drawing before its ready arrived',
      should: 'deliver at once — it is demonstrably up, and no reason to make the user wait out the backstop',
      actual: inputs(fake.emitted),
      expected: ['fix the build', '\r'],
    });
  });

  test('two panes on ONE socket: only the prompted pane is typed at, and closing one leaves the other alive', async () => {
    // Every pane in the grid shares a single socket, so each sees the others'
    // events. This is the machinery `isMine` and the per-mount latches rest on —
    // and until now the fake socket could not even hold two panes at once.
    const fake = fakeSocket();
    const paneA = render(
      <XtermTerminal socket={fake.socket} sessionId="a" connectPayload={CONNECT} initialInput="fix the build" />
    );
    render(<XtermTerminal socket={fake.socket} sessionId="b" connectPayload={{ ...CONNECT, name: 'codex-b2' }} />);
    await waitFor(() => expect(fake.connectionIds().length).toBe(2));
    const [idA, idB] = fake.connectionIds();

    // B boots and draws. A must not read that as its own agent waking up.
    fake.server('agent-terminal:ready', { connectionId: idB });
    fake.server('agent-terminal:output', { data: 'codex> ', connectionId: idB });
    const afterBOnly = inputs(fake.emitted);

    // Now A's own agent comes up.
    fake.server('agent-terminal:ready', { connectionId: idA });
    fake.server('agent-terminal:output', { data: 'claude> ', connectionId: idA });

    paneA.unmount();
    const listenersAfterAClosed = fake.listenerCount('agent-terminal:output');

    assert({
      given: "two panes multiplexed on one socket, only one of them holding a starting prompt",
      should:
        "type the prompt only when A's OWN agent is up — a sibling's output must never spend it — and leave B's listener registered when A is closed",
      actual: {
        typedOnBsOutput: afterBOnly,
        typedOnAsOutput: inputs(fake.emitted),
        listenersAfterAClosed,
      },
      expected: {
        typedOnBsOutput: [],
        typedOnAsOutput: ['fix the build', '\r'],
        listenersAfterAClosed: 1,
      },
    });
  });

  test('output that flows without a ready is never typed at, and the prompt is not spent', async () => {
    // Every server path emits `ready` today, so this is not reachable — but the
    // delivery gate is now hard, and a future error path that streams output
    // without announcing readiness would leave the prompt undelivered AND unspent.
    // Pin the intent so that path is caught rather than shipped.
    const fake = fakeSocket();
    const onSent = vi.fn();
    render(
      <XtermTerminal
        socket={fake.socket}
        sessionId="s1"
        connectPayload={CONNECT}
        initialInput="fix the build"
        onInitialInputSent={onSent}
      />
    );
    await waitFor(() => expect(fake.hasHandlers()).toBe(true));

    fake.server('agent-terminal:output', { data: 'something', connectionId: fake.connectionId() });
    await vi.advanceTimersByTimeAsync(5000);

    assert({
      given: 'a pane receiving output but never a ready',
      should: 'type nothing — with no ready there is no `resumed`, so there is no way to know what it would be typing into',
      actual: { typed: inputs(fake.emitted), promptSpent: onSent.mock.calls.length },
      expected: { typed: [], promptSpent: 0 },
    });
  });
});
