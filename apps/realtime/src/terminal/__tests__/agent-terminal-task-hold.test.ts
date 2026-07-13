/**
 * Wiring tests for the Sprites Tasks API hold (leaf 5-1): the terminal handler
 * must hold the sprite up while a viewer is attached or agent output is
 * flowing, release it on detach-with-idle-agent, and delete it at session end
 * — all through the injected `createTaskHold` seam, so these tests drive the
 * handler with a recording fake controller and never touch a platform.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildAgentTerminalHandlers } from '../agent-terminal-handler';
import { createTerminalSessionMap } from '../terminal-session-map';
import type { AgentTerminalCheckAuthFn, OpenShellFn, SocketLike } from '../agent-terminal-handler';
import type { OpenPtyShellArgs, PtyShell } from '../sprites-shell';
import type { TaskHoldController, TaskHoldState } from '@pagespace/lib/services/sandbox/sandbox-client/sprite-tasks';
import { assert } from './riteway';

const TICK_INTERVAL_MS = 60_000;

function makeShell(): PtyShell & { kill: ReturnType<typeof vi.fn> } {
  return { write: vi.fn(), resize: vi.fn(), kill: vi.fn(), setViewerAttached: vi.fn() };
}

function makeSocket(id = 'sock1', userId = 'user1'): SocketLike & { emit: ReturnType<typeof vi.fn> } {
  return { id, data: { user: { id: userId } }, emit: vi.fn() };
}

function makeSprite() {
  return {
    name: 'sbx1',
    spawn: vi.fn(),
    createSession: vi.fn(),
    attachSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    filesystem: vi.fn(),
    updateNetworkPolicy: vi.fn(),
    destroy: vi.fn(),
  };
}

function makeAuthSuccess(sessionKey = 'branch1:agent:cli') {
  const sprite = makeSprite();
  return {
    ok: true as const,
    sessionKey,
    payerId: 'owner-1',
    sprite,
    resolveSandbox: vi.fn(async () => ({
      ok: true as const,
      agentTerminalId: 'agent-terminal-1',
      sandboxId: 'sbx1',
      cwd: '/workspace',
      sprite,
      command: 'claude',
      args: [],
      commandOverride: null,
      streamSessionId: null,
      releaseSlot: vi.fn(),
    })),
  };
}

/** A recording TaskHoldController: every tick's state, and whether end() ran. */
function makeRecordingHold() {
  const ticks: TaskHoldState[] = [];
  let ended = false;
  const controller: TaskHoldController = {
    tickIntervalMs: TICK_INTERVAL_MS,
    tick: (state) => {
      ticks.push({ ...state });
    },
    end: () => {
      ended = true;
    },
  };
  return { controller, ticks, isEnded: () => ended };
}

const validPayload = { machineId: 't1', projectName: 'repo', branchName: 'feature-x', name: 'cli', cols: 80, rows: 24 };

describe('agent terminal task holds (wiring)', () => {
  let sessionMap: ReturnType<typeof createTerminalSessionMap>;
  let shell: ReturnType<typeof makeShell>;
  let openShell: ReturnType<typeof vi.fn> & OpenShellFn;
  let checkAuth: ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
  let socket: ReturnType<typeof makeSocket>;
  let persistStreamSessionId: ReturnType<typeof vi.fn>;
  let hold: ReturnType<typeof makeRecordingHold>;
  let createTaskHold: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionMap = createTerminalSessionMap();
    shell = makeShell();
    openShell = vi.fn().mockReturnValue(shell) as unknown as ReturnType<typeof vi.fn> & OpenShellFn;
    checkAuth = vi.fn().mockResolvedValue(makeAuthSuccess()) as unknown as ReturnType<typeof vi.fn> & AgentTerminalCheckAuthFn;
    socket = makeSocket();
    persistStreamSessionId = vi.fn().mockResolvedValue(undefined);
    hold = makeRecordingHold();
    createTaskHold = vi.fn().mockReturnValue(hold.controller);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function build() {
    return buildAgentTerminalHandlers({
      sessionMap,
      openShell,
      checkAuth,
      socket,
      persistStreamSessionId,
      createTaskHold: createTaskHold as unknown as Parameters<typeof buildAgentTerminalHandlers>[0]['createTaskHold'],
    });
  }

  it('creates the hold immediately on a fresh attached connect', async () => {
    const handlers = build();
    await handlers.onConnect(validPayload);

    assert({
      given: 'a successful cold connect',
      should: 'construct one controller for the session',
      actual: createTaskHold.mock.calls.length,
      expected: 1,
    });

    assert({
      given: 'a successful cold connect',
      should: 'hand the factory the resolved sprite and session key',
      actual: {
        sessionKey: (createTaskHold.mock.calls[0][0] as { sessionKey: string }).sessionKey,
        hasSprite: Boolean((createTaskHold.mock.calls[0][0] as { sprite?: unknown }).sprite),
      },
      expected: { sessionKey: 'branch1:agent:cli', hasSprite: true },
    });

    assert({
      given: 'a successful cold connect',
      should: 'tick once immediately with the viewer attached',
      actual: hold.ticks,
      expected: [{ attached: true, lastOutputAt: undefined }],
    });
  });

  it('heartbeats on the controller cadence while the session lives', async () => {
    const handlers = build();
    await handlers.onConnect(validPayload);

    vi.advanceTimersByTime(TICK_INTERVAL_MS);
    vi.advanceTimersByTime(TICK_INTERVAL_MS);

    assert({
      given: 'two elapsed heartbeat intervals',
      should: 'have ticked twice more (refresh cadence)',
      actual: hold.ticks.length,
      expected: 3,
    });
  });

  it('carries the latest PTY output time into hold decisions', async () => {
    const handlers = build();
    await handlers.onConnect(validPayload);

    const args = (openShell as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpenPtyShellArgs;
    const before = Date.now();
    args.onOutput('agent says hi');
    vi.advanceTimersByTime(TICK_INTERVAL_MS);

    const lastTick = hold.ticks[hold.ticks.length - 1];
    assert({
      given: 'agent output followed by a heartbeat tick',
      should: 'report when output last flowed',
      actual: lastTick.lastOutputAt !== undefined && lastTick.lastOutputAt >= before,
      expected: true,
    });
  });

  it('ticks detached on viewer disconnect so an idle hold is released', async () => {
    const handlers = build();
    await handlers.onConnect(validPayload);

    handlers.onDisconnect();

    const lastTick = hold.ticks[hold.ticks.length - 1];
    assert({
      given: 'the viewer disconnecting',
      should: 'tick with attached: false (delete when the agent is idle)',
      actual: lastTick.attached,
      expected: false,
    });
  });

  it('ticks attached again when a viewer reattaches to the live session', async () => {
    const handlers = build();
    await handlers.onConnect(validPayload);
    handlers.onDisconnect();

    const socket2 = makeSocket('sock2');
    const handlers2 = buildAgentTerminalHandlers({
      sessionMap,
      openShell,
      checkAuth,
      socket: socket2,
      persistStreamSessionId,
      createTaskHold: createTaskHold as unknown as Parameters<typeof buildAgentTerminalHandlers>[0]['createTaskHold'],
    });
    await handlers2.onConnect(validPayload);

    assert({
      given: 'a reattach to the live session',
      should: 'not construct a second controller (reattach touches no sprite)',
      actual: createTaskHold.mock.calls.length,
      expected: 1,
    });

    const lastTick = hold.ticks[hold.ticks.length - 1];
    assert({
      given: 'a reattach to the live session',
      should: 'tick attached again (the hold must come back)',
      actual: lastTick.attached,
      expected: true,
    });
  });

  it('ends the hold and stops the heartbeat when the PTY exits', async () => {
    const handlers = build();
    await handlers.onConnect(validPayload);

    const args = (openShell as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as OpenPtyShellArgs;
    args.onExit(0);

    assert({
      given: 'the PTY exiting',
      should: 'end the hold (delete on session end)',
      actual: hold.isEnded(),
      expected: true,
    });

    const ticksAtExit = hold.ticks.length;
    vi.advanceTimersByTime(TICK_INTERVAL_MS * 3);
    assert({
      given: 'time passing after the session ended',
      should: 'tick no further (heartbeat cleared by the teardown funnel)',
      actual: hold.ticks.length,
      expected: ticksAtExit,
    });
  });

  it('still connects when no hold factory is wired (optional seam)', async () => {
    const handlers = buildAgentTerminalHandlers({ sessionMap, openShell, checkAuth, socket, persistStreamSessionId });
    await handlers.onConnect(validPayload);

    expect(socket.emit).toHaveBeenCalledWith('agent-terminal:ready', { connectionId: 'sock1', resumed: false });
  });
});
