import { describe, test, beforeEach, afterEach, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { assert } from '@/stores/__tests__/riteway';
import type { Socket } from 'socket.io-client';

// xterm is a DOM/canvas library the pane imports dynamically; stub it so what's
// under test is the PROTOCOL this component speaks over the socket.
const written: string[] = [];
/** Rendered in `written` where a buffer reset happened — the reconnect repaint
 * must RESET-then-replay, never append the replay under what's already shown. */
const RESET_MARK = '⟪reset⟫';
let disposals = 0;
/** The pane's `terminal.onData` callback, captured so a test can simulate the
 * user typing — reset per mount by the mock Terminal's own constructor. */
let onDataHandler: ((data: string) => void) | undefined;
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    onData(handler: (data: string) => void) {
      onDataHandler = handler;
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
    reset() {
      written.push(RESET_MARK);
    }
    dispose() {
      disposals += 1;
    }
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
/** Stable across calls (unlike a fresh `vi.fn()` per `getState()`) so tests can
 * assert on endEditing — the dead-pane leak fix needs it to see across events. */
const editingStore = { startEditing: vi.fn(), endEditing: vi.fn() };
vi.mock('@/stores/useEditingStore', () => ({
  useEditingStore: { getState: () => editingStore },
}));

import XtermTerminal, { RECONNECTING_NOTICE } from './XtermTerminal';

/** A socket that records emits and lets a test drive the server's events. */
function fakeSocket() {
  // A SET of handlers per event, and a working `off` — every pane in the grid
  // registers on this one socket, so a Map of one handler per event could never
  // hold two panes at once, and a no-op `off` could never catch a teardown that
  // failed to unregister. Both are the machinery the prompt latches rest on.
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const fire = (event: string, payload: unknown) => handlers.get(event)?.forEach((handler) => handler(payload));
  const socket = {
    connected: true,
    on: (event: string, handler: (payload: unknown) => void) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
    },
    off: (event: string, handler: (payload: unknown) => void) => {
      handlers.get(event)?.delete(handler);
    },
    emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }),
  };
  return {
    socket: socket as unknown as Socket,
    emitted,
    /** Drive the transport. socket.io reuses the SAME Socket object across a
     * reconnect — a component only ever learns about one from `connected`
     * flipping and the `connect`/`disconnect` lifecycle events. */
    setConnected: (value: boolean) => {
      socket.connected = value;
    },
    /** One full transport cycle: drop, then come back — flag flips before the
     * matching lifecycle event fires, in socket.io's order. */
    reconnect: () => {
      socket.connected = false;
      fire('disconnect', {});
      socket.connected = true;
      fire('connect', {});
    },
    /** The connectionIds the mounted panes announced — every event is tagged with one. */
    connectionIds: () =>
      emitted
        .filter((entry) => entry.event === 'agent-terminal:connect')
        .map((entry) => entry.payload.connectionId as string),
    connectionId: () => emitted.find((entry) => entry.event === 'agent-terminal:connect')?.payload.connectionId,
    server: (event: string, payload: Record<string, unknown>) => fire(event, payload),
    listenerCount: (event: string) => handlers.get(event)?.size ?? 0,
    hasHandlers: () => handlers.size > 0,
  };
}

const CONNECT = { machineId: 'm1', name: 'shell-a1b2c3' };

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
    fake.server('agent-terminal:output', { data: 'shell> ', connectionId });

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
    fake.server('agent-terminal:output', { data: 'shell> ', connectionId });

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
    fake.server('agent-terminal:output', { data: 'shell> ', connectionId: fake.connectionId() });
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

    fake.server('agent-terminal:output', { data: 'shell> ', connectionId });
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
    render(<XtermTerminal socket={fake.socket} sessionId="b" connectPayload={{ ...CONNECT, name: 'other-b2' }} />);
    await waitFor(() => expect(fake.connectionIds().length).toBe(2));
    const [idA, idB] = fake.connectionIds();

    // B boots and draws. A must not read that as its own agent waking up.
    fake.server('agent-terminal:ready', { connectionId: idB });
    fake.server('agent-terminal:output', { data: 'other> ', connectionId: idB });
    const afterBOnly = inputs(fake.emitted);

    // Now A's own agent comes up.
    fake.server('agent-terminal:ready', { connectionId: idA });
    fake.server('agent-terminal:output', { data: 'shell> ', connectionId: idA });

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

  test('a prompt is NOT spent on an emit the socket cannot deliver', async () => {
    const fake = fakeSocket();
    const onSent = vi.fn();
    // The socket dropped (a realtime deploy) while the agent was booting.
    fake.setConnected(false);
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

    fake.server('agent-terminal:ready', { connectionId: fake.connectionId() });
    fake.server('agent-terminal:output', { data: 'shell> ', connectionId: fake.connectionId() });
    await vi.advanceTimersByTimeAsync(5000);

    assert({
      given: 'a socket that is disconnected when the prompt would go out',
      should:
        'keep the prompt unspent — socket.io buffers the emit and flushes it on reconnect carrying a connectionId the server no longer knows, so it is dropped there while the prompt would already have been thrown away here',
      actual: { typed: inputs(fake.emitted), promptSpent: onSent.mock.calls.length },
      expected: { typed: [], promptSpent: 0 },
    });
  });
});

describe('XtermTerminal — PTY binding across socket reconnects', () => {
  beforeEach(() => {
    written.length = 0;
    disposals = 0;
    editingStore.startEditing.mockClear();
    editingStore.endEditing.mockClear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('a transport reconnect re-fires agent-terminal:connect exactly once, on the pane’s own connectionId', async () => {
    const fake = fakeSocket();
    render(<XtermTerminal socket={fake.socket} sessionId="s1" connectPayload={CONNECT} />);
    await waitFor(() => expect(fake.connectionIds().length).toBe(1));
    fake.server('agent-terminal:ready', { connectionId: fake.connectionId() });

    // The transport drops and comes back. socket.io reuses the SAME Socket
    // object, so the [socket, sessionId]-keyed mount effect never re-runs —
    // the `connect` event is the only signal a re-bind can hang off.
    fake.reconnect();

    assert({
      given: 'a live pane whose socket dropped its transport and reconnected',
      should:
        're-emit agent-terminal:connect exactly once, reusing the pane’s connectionId, without recreating the terminal — the server side of the binding died with the transport, and without this the pane looks alive until the idle reap kills its agent',
      actual: {
        connects: fake.connectionIds().length,
        distinctIds: new Set(fake.connectionIds()).size,
        disposed: disposals,
      },
      expected: { connects: 2, distinctIds: 1, disposed: 0 },
    });
  });

  test('the initial connection binds exactly once, wherever mount falls relative to it', async () => {
    // Mounted AFTER the socket connected: the mount effect binds, and no
    // `connect` event follows to double it.
    const early = fakeSocket();
    render(<XtermTerminal socket={early.socket} sessionId="s1" connectPayload={CONNECT} />);
    await waitFor(() => expect(early.connectionIds().length).toBe(1));

    // Mounted BEFORE the socket connected: nothing is emitted into the void —
    // the `connect` event does the one and only bind. (`connect` firing on the
    // INITIAL connection is exactly why re-binding cannot be unconditional.)
    const late = fakeSocket();
    late.setConnected(false);
    render(<XtermTerminal socket={late.socket} sessionId="s2" connectPayload={CONNECT} />);
    await waitFor(() => expect(late.hasHandlers()).toBe(true));
    const whileDown = late.connectionIds().length;
    late.setConnected(true);
    late.server('connect', {});

    assert({
      given: 'one pane mounted after its socket connected, another mounted before',
      should: 'emit exactly one agent-terminal:connect each — never zero, never two',
      actual: { early: early.connectionIds().length, whileDown, late: late.connectionIds().length },
      expected: { early: 1, whileDown: 0, late: 1 },
    });
  });

  test('a reconnect reattach repaints from the replayed scrollback instead of appending it under what is shown', async () => {
    const fake = fakeSocket();
    render(<XtermTerminal socket={fake.socket} sessionId="s1" connectPayload={CONNECT} />);
    await waitFor(() => expect(fake.connectionIds().length).toBe(1));
    const connectionId = fake.connectionId();
    fake.server('agent-terminal:ready', { scrollback: '$ bun run build\n', connectionId });
    fake.server('agent-terminal:output', { data: 'compiling…\n', connectionId });

    fake.reconnect();
    // The server answers a re-bind with the session's FULL scrollback —
    // everything already on this screen plus whatever landed during the gap.
    fake.server('agent-terminal:ready', {
      scrollback: '$ bun run build\ncompiling…\ndone\n',
      resumed: true,
      connectionId,
    });
    // A later duplicate ready on the SAME connection must not wipe live output.
    fake.server('agent-terminal:output', { data: '$ ', connectionId });
    fake.server('agent-terminal:ready', { connectionId });

    assert({
      given: 'a pane with content on screen whose re-bind is answered with the full scrollback replay',
      should:
        'surface the drop, then reset the buffer ONCE and repaint from the replay — appending would duplicate everything already shown, and disposing would tear down the terminal the fix exists to preserve',
      actual: { rendered: written, disposed: disposals },
      expected: {
        rendered: [
          '$ bun run build\n',
          'compiling…\n',
          RECONNECTING_NOTICE,
          RESET_MARK,
          '$ bun run build\ncompiling…\ndone\n',
          '$ ',
        ],
        disposed: 0,
      },
    });
  });

  test('a re-bind ready WITHOUT a replay keeps the buffer — resetting would blank a pane full of history', async () => {
    const fake = fakeSocket();
    render(<XtermTerminal socket={fake.socket} sessionId="s1" connectPayload={CONNECT} />);
    await waitFor(() => expect(fake.connectionIds().length).toBe(1));
    const connectionId = fake.connectionId();
    fake.server('agent-terminal:ready', { scrollback: '$ ls\n', connectionId });
    fake.server('agent-terminal:output', { data: 'README.md\n', connectionId });

    fake.reconnect();
    // The session died while disconnected and the server cold-created a fresh
    // PTY (no scrollback) — or a resumed session's over-cap ring trimmed to
    // empty. Either way there is nothing to repaint FROM.
    fake.server('agent-terminal:ready', { resumed: true, connectionId });
    fake.server('agent-terminal:output', { data: '$ ', connectionId });

    assert({
      given: 'a re-bind answered by a ready that carries no scrollback',
      should: 'keep every byte on screen and let new output append under the notice — a reset would leave nothing to redraw',
      actual: { rendered: written, disposed: disposals },
      expected: {
        rendered: ['$ ls\n', 'README.md\n', RECONNECTING_NOTICE, '$ '],
        disposed: 0,
      },
    });
  });

  test('a pane whose process EXITED never auto-rebinds — a reconnect must not resurrect a finished agent', async () => {
    const fake = fakeSocket();
    render(<XtermTerminal socket={fake.socket} sessionId="s1" connectPayload={CONNECT} />);
    await waitFor(() => expect(fake.connectionIds().length).toBe(1));
    const connectionId = fake.connectionId();
    fake.server('agent-terminal:ready', { connectionId });
    fake.server('agent-terminal:closed', { exitCode: 0, connectionId });

    const printedBeforeDrop = written.length;
    fake.reconnect();

    assert({
      given: 'a pane showing "process exited" whose socket then drops and reconnects',
      should:
        'emit no further agent-terminal:connect and print no reconnecting promise — the server has no session left under this key, so a re-bind would take its cold CREATE path and silently launch (and bill) a brand-new agent nobody asked for',
      actual: { connects: fake.connectionIds().length, printedOnDrop: written.length - printedBeforeDrop },
      expected: { connects: 1, printedOnDrop: 0 },
    });
  });

  test('a pane the server REFUSED never auto-rebinds — reconnect cycles must not retry a denied bind', async () => {
    const fake = fakeSocket();
    render(<XtermTerminal socket={fake.socket} sessionId="s1" connectPayload={CONNECT} />);
    await waitFor(() => expect(fake.connectionIds().length).toBe(1));
    const connectionId = fake.connectionId();
    fake.server('agent-terminal:error', { message: 'Agent terminal access denied', connectionId });

    const printedBeforeDrop = written.length;
    fake.reconnect();

    assert({
      given: 'a pane whose bind the server denied (access revoked, insufficient credits), riding out a transport cycle',
      should:
        'stay in its error state — re-emitting the denied connect on every reconnect would flap between "reconnecting" and the same denial forever',
      actual: { connects: fake.connectionIds().length, printedOnDrop: written.length - printedBeforeDrop },
      expected: { connects: 1, printedOnDrop: 0 },
    });
  });

  test('output racing ahead of a re-bind’s ready is never typed at — the OLD binding’s ready does not vouch for the NEW agent', async () => {
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
    await waitFor(() => expect(fake.connectionIds().length).toBe(1));
    const connectionId = fake.connectionId();

    // The old binding: a fresh boot's ready arrives (arming the backstop), but
    // the transport drops before anything was typed.
    fake.server('agent-terminal:ready', { resumed: false, connectionId });
    fake.reconnect();

    // The new binding's output beats its ready (the server's ordering, not
    // ours). The old ready's `resumed: false` said nothing about THIS agent —
    // typing here would trust stale evidence.
    fake.server('agent-terminal:output', { data: 'y/n? ', connectionId });
    const typedBeforeNewReady = inputs(fake.emitted);

    // And the new ready reveals the truth: the agent was already running.
    fake.server('agent-terminal:ready', { resumed: true, connectionId });
    await vi.advanceTimersByTimeAsync(5000);

    assert({
      given: 'a re-bind whose output arrives before its ready, after the OLD binding had seen a fresh-boot ready',
      should:
        'type NOTHING on the stale latches and spend the prompt only when the new ready says resumed — each binding must re-prove what it is talking to',
      actual: {
        typedBeforeNewReady,
        typed: inputs(fake.emitted),
        promptDropped: onSent.mock.calls.length,
      },
      expected: { typedBeforeNewReady: [], typed: [], promptDropped: 1 },
    });
  });

  test('a pane that goes dead (exited, or refused) releases its editing-store registration immediately', async () => {
    const fake = fakeSocket();
    render(<XtermTerminal socket={fake.socket} sessionId="exited-pane" connectPayload={CONNECT} />);
    await waitFor(() => expect(fake.connectionIds().length).toBe(1));
    const connectionId = fake.connectionId();
    fake.server('agent-terminal:ready', { connectionId });
    expect(editingStore.startEditing).toHaveBeenCalledWith('exited-pane', 'other', { componentName: 'agent-terminal' });

    fake.server('agent-terminal:closed', { exitCode: 0, connectionId });

    assert({
      given: 'a pane whose agent process exits while the pane stays mounted (dead panes never unmount on their own)',
      should:
        'release the editing-store registration right away — a finished pane must not go on blocking auth refresh/SWR updates for its sessionId until some later, unrelated unmount',
      actual: editingStore.endEditing.mock.calls,
      expected: [['exited-pane']],
    });
  });

  test('typed input is never emitted while the transport is down — it would only sit in socket.io’s buffer and be dropped on the other side anyway', async () => {
    const fake = fakeSocket();
    render(<XtermTerminal socket={fake.socket} sessionId="s1" connectPayload={CONNECT} />);
    await waitFor(() => expect(fake.connectionIds().length).toBe(1));

    fake.setConnected(false);
    fake.server('disconnect', {});
    onDataHandler?.('y');
    const emittedWhileDown = inputs(fake.emitted);

    fake.setConnected(true);
    fake.server('connect', {});
    onDataHandler?.('y');

    assert({
      given: 'a keystroke typed while the socket is disconnected, then one typed after it reconnects',
      should: 'emit nothing for the disconnected keystroke, and emit normally once reconnected',
      actual: { emittedWhileDown, emittedAfterReconnect: inputs(fake.emitted) },
      expected: { emittedWhileDown: [], emittedAfterReconnect: ['y'] },
    });
  });
});
