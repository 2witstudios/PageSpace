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
  const handlers = new Map<string, (payload: unknown) => void>();
  const emitted: Array<{ event: string; payload: Record<string, unknown> }> = [];
  return {
    socket: {
      on: (event: string, handler: (payload: unknown) => void) => handlers.set(event, handler),
      off: () => {},
      emit: (event: string, payload: Record<string, unknown>) => emitted.push({ event, payload }),
    } as unknown as Socket,
    emitted,
    /** The connectionId this pane announced on connect — every event is tagged with it. */
    connectionId: () => emitted.find((entry) => entry.event === 'agent-terminal:connect')?.payload.connectionId,
    server: (event: string, payload: Record<string, unknown>) => handlers.get(event)?.(payload),
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

  test('a REATTACHED agent is never typed at — the prompt is discarded, not delivered', async () => {
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

  test('a pane unmounted before the backstop fires never types at the agent afterwards', async () => {
    const fake = fakeSocket();
    const { unmount } = render(
      <XtermTerminal socket={fake.socket} sessionId="s1" connectPayload={CONNECT} initialInput="fix the build" />
    );
    await waitFor(() => expect(fake.hasHandlers()).toBe(true));

    fake.server('agent-terminal:ready', { connectionId: fake.connectionId() });
    unmount();
    await vi.advanceTimersByTimeAsync(5000);

    assert({
      given: 'a pane closed (or a workspace switched away from) while its agent was still booting',
      should: 'cancel the pending write — a timer left armed would type into a terminal whose pane is gone',
      actual: inputs(fake.emitted),
      expected: [],
    });
  });
});
