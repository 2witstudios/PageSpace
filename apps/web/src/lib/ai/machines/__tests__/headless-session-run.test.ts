import { describe, it } from 'vitest';
import { assert } from '@/lib/ai/tools/__tests__/riteway';

import {
  dispatchHeadlessSessionTurn,
  isClaimContested,
  MAX_AGENT_DEPTH,
  type HeadlessSessionRunDeps,
  type HeadlessSessionTarget,
} from '../headless-session-run';
import type { SessionTerminalIdentity } from '@/lib/ai/tools/session-tools';
import type {
  MachineNodeHandle,
  MachineNodeHandleSet,
} from '@pagespace/lib/services/machines/machine-pane-binding';

function branchHandle(): MachineNodeHandle {
  return {
    kind: 'branch',
    machineId: 'machine-page-1',
    project: 'repo',
    branch: 'feature',
    cwd: '/repo',
    branchSandbox: { machineBranchId: 'br-1', sandboxId: 'sbx-1' },
  };
}

function branchBinding(): MachineNodeHandleSet {
  const self = branchHandle();
  return { self, handles: [self] };
}

function identity(): SessionTerminalIdentity {
  return {
    node: { kind: 'machine', machineId: 'machine-page-1', cwd: '/home/pagespace' },
    name: 'worker',
    address: { machineId: 'machine-page-1', projectName: 'repo', branchName: 'feature', name: 'worker' },
  };
}

function target(): HeadlessSessionTarget {
  return {
    machineId: 'machine-page-1',
    conversationId: 'terminal-row-1',
    node: branchHandle(),
    binding: branchBinding(),
    title: 'Dev Machine',
    name: 'worker',
  };
}

interface Recorded {
  claims: number;
  creditChecks: string[];
  holdsReleased: string[];
  appended: { content: string; conversationId: string }[];
  generated: { depth: number; cwd: string; sandboxId?: string; message: string }[];
  replies: { content: string; aborted: boolean }[];
  billed: { pageId: string; userId: string; success: boolean; provider?: string; model?: string }[];
  historyLoads: { excludeMessageId: string }[];
  released: { aborted: boolean }[];
  /** Set at ACK time, so "did the loop run before the ACK?" is directly assertable. */
  ackedBeforeRun: boolean;
}

function deps(
  overrides: Partial<HeadlessSessionRunDeps> = {},
  options: { claimBusy?: boolean } = {},
): { deps: HeadlessSessionRunDeps; recorded: Recorded; drain: () => Promise<void> } {
  const recorded: Recorded = {
    claims: 0,
    creditChecks: [],
    holdsReleased: [],
    appended: [],
    generated: [],
    replies: [],
    billed: [],
    historyLoads: [],
    released: [],
    ackedBeforeRun: false,
  };
  let ids = 0;
  const deferred: (() => Promise<void>)[] = [];

  const base: HeadlessSessionRunDeps = {
    resolveTarget: async () => target(),
    checkCredit: async ({ userId }) => {
      recorded.creditChecks.push(userId);
      return { allowed: true, holdId: 'hold-1' };
    },
    releaseHold: async (holdId) => {
      recorded.holdsReleased.push(holdId);
    },
    claimRun: async () => {
      recorded.claims += 1;
      if (options.claimBusy) return { ok: false, reason: 'busy' };
      return {
        ok: true,
        claim: {
          messageId: 'assistant-1',
          release: async ({ aborted }) => {
            recorded.released.push({ aborted });
          },
        },
      };
    },
    appendMessage: async ({ content, target: to }) => {
      recorded.appended.push({ content, conversationId: to.conversationId });
    },
    loadHistory: async (_target, opts) => {
      recorded.historyLoads.push(opts);
      return [];
    },
    generate: async ({ depth, target: to, message }) => {
      recorded.generated.push({
        depth,
        cwd: to.binding.self.cwd,
        sandboxId: to.binding.self.branchSandbox?.sandboxId,
        message,
      });
      return {
        text: 'done',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-5',
      };
    },
    persistReply: async ({ content, aborted }) => {
      recorded.replies.push({ content, aborted });
    },
    trackUsage: async ({ pageId, userId, success, provider, model }) => {
      recorded.billed.push({ pageId, userId, success, provider, model });
    },
    newId: () => `id${++ids}`,
    defer: (run) => {
      deferred.push(run);
    },
  };

  return {
    deps: { ...base, ...overrides },
    recorded,
    drain: async () => {
      while (deferred.length > 0) {
        const run = deferred.shift()!;
        await run();
      }
    },
  };
}

describe('isClaimContested — the post-insert half of the conversation claim', () => {
  const NOW = new Date('2026-07-22T12:00:00Z');
  const STALE = 60_000;
  const fresh = new Date(NOW.getTime() - 1_000);
  const stale = new Date(NOW.getTime() - STALE - 1);

  it('a fresh FOREIGN stream on the conversation contests the claim — the human registered in the check→insert window', () => {
    expect(isClaimContested([{ streamId: 'client-stream-9', lastHeartbeatAt: fresh }], 'session-run:c1', STALE, NOW)).toBe(true);
  });

  it('a foreign stream with a NULL streamId still contests — released rows keep beating until their writer stops', () => {
    expect(isClaimContested([{ streamId: null, lastHeartbeatAt: fresh }], 'session-run:c1', STALE, NOW)).toBe(true);
  });

  it('our OWN claim row never contests itself', () => {
    expect(isClaimContested([{ streamId: 'session-run:c1', lastHeartbeatAt: fresh }], 'session-run:c1', STALE, NOW)).toBe(false);
  });

  it('a stale foreign row does not contest — same heartbeat authority as the pre-check', () => {
    expect(isClaimContested([{ streamId: 'client-stream-9', lastHeartbeatAt: stale }], 'session-run:c1', STALE, NOW)).toBe(false);
  });
});

describe('dispatchHeadlessSessionTurn — the dispatched message appears in the context ONCE', () => {
  it('loadHistory is told to exclude the just-appended message — generate carries it explicitly', async () => {
    // The dispatch appends the user message BEFORE the deferred run starts, so
    // an unfiltered history read returns it — and generate() appends
    // input.message again, handing the model every instruction twice.
    const { deps: d, recorded, drain } = deps();

    await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'user-1' }, message: 'go', depth: 0 },
      d,
    );
    await drain();

    expect(recorded.appended).toHaveLength(1);
    expect(recorded.historyLoads).toHaveLength(1);
    // The exclusion id IS the appended message's id.
    expect(recorded.historyLoads[0].excludeMessageId).toBeTruthy();
  });
});

describe('dispatchHeadlessSessionTurn — billing identity', () => {
  it('meters the run on the provider/model generate() ACTUALLY used — never a hardcoded default', async () => {
    // The machine page picks its own provider/model; billing on the default
    // rate would mischarge every non-default machine agent turn.
    const { deps: d, recorded, drain } = deps();

    await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'user-1' }, message: 'go', depth: 0 },
      d,
    );
    await drain();

    expect(recorded.billed).toEqual([
      {
        pageId: 'machine-page-1',
        userId: 'user-1',
        success: true,
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-5',
      },
    ]);
  });
});

describe('dispatchHeadlessSessionTurn — credit gate', () => {
  it('given a denied credit gate, should refuse BEFORE claiming or appending anything', async () => {
    // The interactive path refuses a user at their limit up front
    // (chat/route.ts's canConsumeAI gate); a dispatch reaching the same loop
    // without that check would let send_session drive unbounded chains on an
    // exhausted balance.
    const { deps: d, recorded } = deps({
      checkCredit: async () => ({ allowed: false, reason: 'insufficient_credits' }),
    });

    const result = await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'user-1' }, message: 'go', depth: 0 },
      d,
    );

    expect(result).toEqual({ ok: false, reason: 'credit_denied', detail: 'insufficient_credits' });
    expect(recorded.claims).toBe(0);
    expect(recorded.appended).toEqual([]);
  });

  it('given an allowed gate with a hold, should release the hold after the run — success or not', async () => {
    const { deps: d, recorded, drain } = deps();

    await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'user-1' }, message: 'go', depth: 0 },
      d,
    );
    await drain();

    expect(recorded.creditChecks).toEqual(['user-1']);
    expect(recorded.holdsReleased).toEqual(['hold-1']);
  });

  it('given the generate loop THROWS, should still release the hold', async () => {
    const { deps: d, recorded, drain } = deps({
      generate: async () => {
        throw new Error('provider down');
      },
    });

    await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'user-1' }, message: 'go', depth: 0 },
      d,
    );
    await drain();

    expect(recorded.holdsReleased).toEqual(['hold-1']);
  });

  it('given a depth-capped dispatch, should never even check credit', async () => {
    const { deps: d, recorded } = deps();

    const result = await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'user-1' }, message: 'go', depth: 2 },
      d,
    );

    expect(result).toEqual({ ok: false, reason: 'depth_exceeded' });
    expect(recorded.creditChecks).toEqual([]);
  });
});

describe('dispatchHeadlessSessionTurn', () => {
  it('given a message for an agent session, should append it, ACK, and only then run the loop', async () => {
    const { deps: d, recorded, drain } = deps();

    const result = await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'u1' }, message: 'ship it', depth: 0 },
      d,
    );
    const atAck = {
      ok: result.ok,
      appended: recorded.appended.length,
      generated: recorded.generated.length,
    };
    await drain();

    assert({
      given: 'a dispatch to an agent session',
      should: 'persist the message and acknowledge before the loop has run, then run it',
      actual: { atAck, afterDrain: { generated: recorded.generated.length, replies: recorded.replies } },
      expected: {
        atAck: { ok: true, appended: 1, generated: 0 },
        afterDrain: { generated: 1, replies: [{ content: 'done', aborted: false }] },
      },
    });
  });

  it('given a target at a branch node, should run the loop with the TARGET node\'s own binding', async () => {
    const { deps: d, recorded, drain } = deps();

    await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'u1' }, message: 'build', depth: 0 },
      d,
    );
    await drain();

    assert({
      given: 'a dispatch to a session that lives in a branch sandbox',
      should: 'run at the branch cwd inside the branch Sprite, not the dispatcher\'s node',
      actual: { cwd: recorded.generated[0]?.cwd, sandboxId: recorded.generated[0]?.sandboxId },
      expected: { cwd: '/repo', sandboxId: 'sbx-1' },
    });
  });

  it('given a conversation already generating, should refuse and persist nothing', async () => {
    const { deps: d, recorded, drain } = deps({}, { claimBusy: true });

    const result = await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'u1' }, message: 'hello', depth: 0 },
      d,
    );
    await drain();

    assert({
      given: 'a run-claim lost to a live client stream or a concurrent dispatch',
      should: 'refuse as busy, leaving no message and no run behind',
      actual: {
        result,
        appended: recorded.appended.length,
        generated: recorded.generated.length,
      },
      expected: { result: { ok: false, reason: 'busy' }, appended: 0, generated: 0 },
    });
  });

  it('given a dispatch chain already at the cap, should refuse before claiming anything', async () => {
    const { deps: d, recorded } = deps();

    const result = await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'u1' }, message: 'deeper', depth: MAX_AGENT_DEPTH },
      d,
    );

    assert({
      given: `a dispatch arriving at depth ${MAX_AGENT_DEPTH}`,
      should: 'refuse without claiming or appending',
      actual: { result, claims: recorded.claims, appended: recorded.appended.length },
      expected: { result: { ok: false, reason: 'depth_exceeded' }, claims: 0, appended: 0 },
    });
  });

  it('given a chain A→B→C, should run each link one level deeper and refuse the next', async () => {
    const { deps: d, recorded, drain } = deps();

    // A dispatches to B at depth 0; B's run executes at depth 1 and dispatches
    // to C, whose run executes at depth 2 — the cap, so C may dispatch nowhere.
    await dispatchHeadlessSessionTurn({ identity: identity(), actor: { userId: 'u1' }, message: 'B', depth: 0 }, d);
    await drain();
    await dispatchHeadlessSessionTurn({ identity: identity(), actor: { userId: 'u1' }, message: 'C', depth: 1 }, d);
    await drain();
    const fromC = await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'u1' }, message: 'D', depth: 2 },
      d,
    );

    assert({
      given: 'three chained dispatches',
      should: 'deepen the run each hop and refuse the fourth',
      actual: { depths: recorded.generated.map((run) => run.depth), fromC },
      expected: { depths: [1, 2], fromC: { ok: false, reason: 'depth_exceeded' } },
    });
  });

  it('given a completed headless run, should bill the OWNING MACHINE PAGE', async () => {
    const { deps: d, recorded, drain } = deps();

    await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'u1' }, message: 'work', depth: 0 },
      d,
    );
    await drain();

    assert({
      given: 'a headless run at a branch node of a machine',
      should: 'meter against the owning machine page id, attributed to the dispatching user',
      actual: recorded.billed,
      expected: [
        {
          pageId: 'machine-page-1',
          userId: 'u1',
          success: true,
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-5',
        },
      ],
    });
  });

  it('given a loop that throws, should write a terminal transcript entry, still bill, and release the claim', async () => {
    const { deps: d, recorded, drain } = deps({
      generate: async () => {
        throw new Error('provider exploded');
      },
    });

    await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'u1' }, message: 'work', depth: 0 },
      d,
    );
    await drain();

    assert({
      given: 'a dispatched run whose model call fails',
      should: 'record the failure in the transcript, meter it, and free the session',
      actual: {
        aborted: recorded.replies[0]?.aborted,
        mentionsError: recorded.replies[0]?.content.includes('provider exploded'),
        billed: recorded.billed.map((entry) => entry.success),
        released: recorded.released,
      },
      expected: { aborted: true, mentionsError: true, billed: [false], released: [{ aborted: true }] },
    });
  });

  it('given a session that is not an agent session, should refuse without claiming', async () => {
    const { deps: d, recorded } = deps({ resolveTarget: async () => null });

    const result = await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'u1' }, message: 'hi', depth: 0 },
      d,
    );

    assert({
      given: 'an addressed session with no agent loop behind it',
      should: 'refuse before claiming',
      actual: { result, claims: recorded.claims },
      expected: { result: { ok: false, reason: 'not_an_agent_session' }, claims: 0 },
    });
  });

  it('given an append that fails after the claim, should release the claim rather than wedge the session', async () => {
    const { deps: d, recorded } = deps({
      appendMessage: async () => {
        throw new Error('db down');
      },
    });

    const result = await dispatchHeadlessSessionTurn(
      { identity: identity(), actor: { userId: 'u1' }, message: 'hi', depth: 0 },
      d,
    );

    assert({
      given: 'a claimed dispatch whose message write fails',
      should: 'report the failure and free the claim',
      actual: { ok: result.ok, released: recorded.released },
      expected: { ok: false, released: [{ aborted: true }] },
    });
  });
});
