import { describe, it, expect } from 'vitest';
import {
  nextShellLabel,
  planSpawnShell,
  planKillTarget,
  planSpawnWorkerSession,
  isValidShellName,
  MAX_AGENT_DEPTH,
  MAX_SESSION_CONVERSATIONS,
  SHELL_LABEL_PREFIX,
  type PlanSpawnWorkerSessionInput,
} from '../plan-spawn-session';

describe('nextShellLabel', () => {
  it('given no shells, should label the first one shell-1', () => {
    expect(nextShellLabel([])).toBe('shell-1');
  });

  it('given shell-1..n, should label the next shell-(n+1)', () => {
    expect(nextShellLabel(['shell-1'])).toBe('shell-2');
    expect(nextShellLabel(['shell-1', 'shell-2'])).toBe('shell-3');
    expect(nextShellLabel(['shell-1', 'shell-2', 'shell-3'])).toBe('shell-4');
  });

  it('should never collide with an existing label, whatever the gaps', () => {
    expect(nextShellLabel(['shell-1', 'shell-3'])).toBe('shell-4');
    expect(nextShellLabel(['shell-2', 'shell-3', 'shell-4'])).toBe('shell-5');
  });

  it('given renamed shells, should still count them and skip any collision', () => {
    expect(nextShellLabel(['build', 'logs'])).toBe('shell-3');
    expect(nextShellLabel(['build', 'shell-3'])).toBe('shell-4');
  });

  it('should be order-insensitive', () => {
    expect(nextShellLabel(['shell-3', 'shell-1', 'shell-2'])).toBe('shell-4');
  });

  it('should always produce a valid shell name', () => {
    expect(isValidShellName(nextShellLabel([]))).toBe(true);
    expect(nextShellLabel([]).startsWith(SHELL_LABEL_PREFIX)).toBe(true);
  });
});

describe('planSpawnShell', () => {
  it('given no requested name, should auto-label', () => {
    const plan = planSpawnShell({ existingNames: ['shell-1'] });
    expect(plan).toEqual({ ok: true, name: 'shell-2', autoLabeled: true });
  });

  it('given an empty requested name, should auto-label rather than reject', () => {
    const plan = planSpawnShell({ existingNames: [], requestedName: '   ' });
    expect(plan).toEqual({ ok: true, name: 'shell-1', autoLabeled: true });
  });

  it('given a free requested name, should take it verbatim', () => {
    expect(planSpawnShell({ existingNames: ['shell-1'], requestedName: 'build' })).toEqual({
      ok: true,
      name: 'build',
      autoLabeled: false,
    });
  });

  it('given a requested name that is taken, should reject — (sessionId, name) is unique for tab clarity', () => {
    const plan = planSpawnShell({ existingNames: ['build'], requestedName: 'build' });
    expect(plan).toEqual({ ok: false, reason: 'name_taken' });
  });

  it('given a malformed requested name, should reject', () => {
    expect(planSpawnShell({ existingNames: [], requestedName: '-leading-dash' })).toEqual({
      ok: false,
      reason: 'invalid_name',
    });
    expect(planSpawnShell({ existingNames: [], requestedName: 'has spaces' })).toEqual({
      ok: false,
      reason: 'invalid_name',
    });
    expect(planSpawnShell({ existingNames: [], requestedName: 'a'.repeat(101) })).toEqual({
      ok: false,
      reason: 'invalid_name',
    });
  });

  it('should trim a requested name before validating it', () => {
    expect(planSpawnShell({ existingNames: [], requestedName: '  build  ' })).toEqual({
      ok: true,
      name: 'build',
      autoLabeled: false,
    });
  });
});

describe('isValidShellName', () => {
  it.each(['shell-1', 'build', 'A_b-2', '9'])('given %s, should accept', (name) => {
    expect(isValidShellName(name)).toBe(true);
  });

  it.each(['', ' ', '-x', '_x', 'a b', 'a/b', 'a'.repeat(101)])('given %p, should reject', (name) => {
    expect(isValidShellName(name)).toBe(false);
  });
});

describe('planKillTarget', () => {
  it('given a known target, should plan the kill', () => {
    expect(planKillTarget({ knownIds: ['s1', 's2'], targetId: 's1' })).toEqual({ ok: true, action: 'kill', targetId: 's1' });
  });

  it('given a target that is already gone, should succeed as a noop (404-as-success)', () => {
    expect(planKillTarget({ knownIds: ['s2'], targetId: 's1' })).toEqual({
      ok: true,
      action: 'noop',
      targetId: 's1',
      reason: 'already_gone',
    });
  });

  it('given an empty registry, should still succeed as a noop', () => {
    expect(planKillTarget({ knownIds: [], targetId: 's1' })).toMatchObject({ ok: true, action: 'noop' });
  });

  it('given an empty target id, should reject (ids address; an empty one addresses nothing)', () => {
    expect(planKillTarget({ knownIds: ['s1'], targetId: '' })).toEqual({ ok: false, reason: 'invalid_target' });
  });

  it('should be usable for BOTH registries (shells and worker sessions) — it only knows ids', () => {
    expect(planKillTarget({ knownIds: ['conv-1'], targetId: 'conv-1' }).ok).toBe(true);
    expect(planKillTarget({ knownIds: ['shell-row-1'], targetId: 'shell-row-1' }).ok).toBe(true);
  });
});

describe('planSpawnWorkerSession', () => {
  function input(overrides: Partial<PlanSpawnWorkerSessionInput> = {}): PlanSpawnWorkerSessionInput {
    return {
      name: 'parser worker',
      prompt: 'Refactor the parser and report back',
      callerDepth: 0,
      sessionConversationCount: 0,
      ...overrides,
    };
  }

  it('given a name and prompt, should plan the spawn at the caller depth + 1', () => {
    expect(planSpawnWorkerSession(input())).toEqual({
      ok: true,
      name: 'parser worker',
      prompt: 'Refactor the parser and report back',
      agentId: null,
      childDepth: 1,
    });
  });

  it('given an agent to spawn under, should carry its id (an agentId, never a "page")', () => {
    const plan = planSpawnWorkerSession(input({ agentId: 'page-agent-1' }));
    if (!plan.ok) throw new Error('expected ok');
    expect(plan.agentId).toBe('page-agent-1');
  });

  it('given a duplicate worker name, should still allow it — worker names are FREE labels', () => {
    const plan = planSpawnWorkerSession(input({ name: 'worker', existingNames: ['worker', 'worker'] }));
    if (!plan.ok) throw new Error('expected ok');
    expect(plan.name).toBe('worker');
  });

  it('given a name with spaces and punctuation, should pass it through (labels are not addresses)', () => {
    const plan = planSpawnWorkerSession(input({ name: 'Parser / cleanup #2' }));
    if (!plan.ok) throw new Error('expected ok');
    expect(plan.name).toBe('Parser / cleanup #2');
  });

  it('should trim the label', () => {
    const plan = planSpawnWorkerSession(input({ name: '  worker  ' }));
    if (!plan.ok) throw new Error('expected ok');
    expect(plan.name).toBe('worker');
  });

  it('given a blank name, should reject', () => {
    expect(planSpawnWorkerSession(input({ name: '   ' }))).toEqual({ ok: false, reason: 'invalid_name' });
  });

  it('given an absurdly long name, should reject', () => {
    expect(planSpawnWorkerSession(input({ name: 'a'.repeat(201) }))).toEqual({ ok: false, reason: 'invalid_name' });
  });

  it('given no prompt, should reject — spawning a worker MEANS giving it work', () => {
    expect(planSpawnWorkerSession(input({ prompt: '' }))).toEqual({ ok: false, reason: 'missing_prompt' });
    expect(planSpawnWorkerSession(input({ prompt: '   ' }))).toEqual({ ok: false, reason: 'missing_prompt' });
  });

  it('should trim the prompt it hands on', () => {
    const plan = planSpawnWorkerSession(input({ prompt: '  do the thing  ' }));
    if (!plan.ok) throw new Error('expected ok');
    expect(plan.prompt).toBe('do the thing');
  });

  it('given a caller already at the depth cap, should reject (no infinite agent recursion)', () => {
    expect(planSpawnWorkerSession(input({ callerDepth: MAX_AGENT_DEPTH }))).toEqual({
      ok: false,
      reason: 'depth_exceeded',
    });
    expect(planSpawnWorkerSession(input({ callerDepth: MAX_AGENT_DEPTH + 1 }))).toEqual({
      ok: false,
      reason: 'depth_exceeded',
    });
  });

  it('given a caller one below the cap, should allow and reach the cap', () => {
    const plan = planSpawnWorkerSession(input({ callerDepth: MAX_AGENT_DEPTH - 1 }));
    if (!plan.ok) throw new Error('expected ok');
    expect(plan.childDepth).toBe(MAX_AGENT_DEPTH);
  });

  it('should carry the ported depth cap of 2', () => {
    expect(MAX_AGENT_DEPTH).toBe(2);
  });

  it('should NOT gate on the sandbox-compute concurrency ceiling — a worker spawn mints a conversation, never a sandbox (codex round 11)', () => {
    // The input type carries no activeSessionCount/concurrencyLimit at all;
    // this pins the planner staying quota-free apart from the session
    // conversation ceiling below (session MINTING is capped separately in
    // spawnAgentSession).
    expect(planSpawnWorkerSession(input()).ok).toBe(true);
  });

  it('should report the input problem before the quota problem', () => {
    expect(
      planSpawnWorkerSession(input({ prompt: '', callerDepth: MAX_AGENT_DEPTH, sessionConversationCount: 99 })),
    ).toEqual({ ok: false, reason: 'missing_prompt' });
  });

  it('should report the depth problem before the quota problem', () => {
    expect(planSpawnWorkerSession(input({ callerDepth: MAX_AGENT_DEPTH, sessionConversationCount: 99 }))).toEqual({
      ok: false,
      reason: 'depth_exceeded',
    });
  });

  it('given a session already at the conversation ceiling, should reject — spawning MINTS a conversation', () => {
    // The sandbox-concurrency inputs above count something a worker spawn never
    // creates, so on their own they leave worker minting unbounded (issue
    // #2262 finding 2). What a spawn actually mints is a conversation, and
    // THIS is the input that counts it.
    expect(planSpawnWorkerSession(input({ sessionConversationCount: MAX_SESSION_CONVERSATIONS }))).toEqual({
      ok: false,
      reason: 'session_full',
    });
    expect(
      planSpawnWorkerSession(input({ sessionConversationCount: MAX_SESSION_CONVERSATIONS + 1 })),
    ).toEqual({ ok: false, reason: 'session_full' });
  });

  it('given one conversation slot left, should allow', () => {
    expect(planSpawnWorkerSession(input({ sessionConversationCount: MAX_SESSION_CONVERSATIONS - 1 })).ok).toBe(
      true,
    );
  });

  it('should carry a conversation ceiling that matches the per-session listing cap', () => {
    // 100 is also listSessionConversationsBulk's per-session cap: a session may
    // never hold more conversations than its sidebar listing can show.
    expect(MAX_SESSION_CONVERSATIONS).toBe(100);
  });
});
