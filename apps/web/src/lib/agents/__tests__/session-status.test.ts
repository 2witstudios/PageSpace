/**
 * Sandbox status derivation and its copy.
 *
 * Two properties are load-bearing here. First: an absent session is `'none'`,
 * not an error — most conversations never touch a sandbox, so "no session row"
 * is the overwhelmingly common, entirely healthy case, and a hook that fetched a
 * 404 must be able to render it without a failure state. Second: the copy says
 * "sandbox" and never "session", because "session" is the tool/backend word for
 * the thing the user calls a conversation.
 */
import { describe, test, expect } from 'vitest';
import type { AgentSessionDTO } from '@pagespace/lib/agent-sessions/contract';
import { deriveSandboxStatus, describeSandboxStatus, isSandboxLive, SANDBOX_STATUS_COPY, resolveDisplayStatus } from '../session-status';

const session = (overrides: Partial<AgentSessionDTO> = {}): AgentSessionDTO => ({
  sessionId: 'conv-1',
  ownerId: 'user-1',
  agentPageId: 'agent-1',
  name: 'Untitled',
  sandboxStatus: 'running',
  createdAt: '2026-07-28T00:00:00.000Z',
  lastActiveAt: null,
  endedAt: null,
  ...overrides,
});

describe('deriveSandboxStatus', () => {
  test('no session row means no sandbox — not an error', () => {
    expect(deriveSandboxStatus(undefined)).toBe('none');
    expect(deriveSandboxStatus(null)).toBe('none');
  });

  test('reports the status the server sent', () => {
    expect(deriveSandboxStatus(session({ sandboxStatus: 'none' }))).toBe('none');
    expect(deriveSandboxStatus(session({ sandboxStatus: 'starting' }))).toBe('starting');
    expect(deriveSandboxStatus(session({ sandboxStatus: 'running' }))).toBe('running');
    expect(deriveSandboxStatus(session({ sandboxStatus: 'ended' }))).toBe('ended');
  });

  test('an ended session reads as ended even while the server still says running', () => {
    // `endedAt` is stamped by the explicit end-session path and the row is kept
    // for re-provisioning, so a status that hasn't caught up yet must not show
    // a live sandbox the user just tore down.
    expect(deriveSandboxStatus(session({ sandboxStatus: 'running', endedAt: '2026-07-28T01:00:00.000Z' }))).toBe(
      'ended',
    );
  });

  test('an unrecognized status degrades to none rather than leaking through', () => {
    // The four in the contract are the only four. A fifth arriving from a newer
    // server is a status this build cannot render, and "no sandbox" is the safe
    // reading — it offers to start one instead of claiming one is live.
    const rogue = { ...session(), sandboxStatus: 'hibernating' } as unknown as AgentSessionDTO;
    expect(deriveSandboxStatus(rogue)).toBe('none');
  });
});

describe('describeSandboxStatus', () => {
  test('every status has copy', () => {
    for (const status of ['none', 'starting', 'running', 'ended'] as const) {
      const copy = describeSandboxStatus(status);
      expect(copy.label.length).toBeGreaterThan(0);
      expect(copy.description.length).toBeGreaterThan(0);
    }
  });

  test('never says "session" to the user', () => {
    // The vocabulary invariant from the contract, enforced rather than
    // documented: users see Agents, conversations, and sandboxes.
    for (const copy of Object.values(SANDBOX_STATUS_COPY)) {
      expect(`${copy.label} ${copy.description}`.toLowerCase()).not.toContain('session');
    }
  });

  test('says "sandbox" where the user needs to know which thing is meant', () => {
    expect(describeSandboxStatus('none').description.toLowerCase()).toContain('sandbox');
    expect(describeSandboxStatus('ended').description.toLowerCase()).toContain('sandbox');
  });

  test('distinguishes the four states in its labels', () => {
    const labels = (['none', 'starting', 'running', 'ended'] as const).map((s) => describeSandboxStatus(s).label);
    expect(new Set(labels).size).toBe(4);
  });
});

describe('isSandboxLive', () => {
  test('only a running sandbox is live', () => {
    // Starting is not live yet (nothing can be opened in it) and ended is not
    // live any more; both are "not now", which is the only distinction callers
    // gating an Add-shell affordance actually need.
    expect(isSandboxLive('running')).toBe(true);
    expect(isSandboxLive('starting')).toBe(false);
    expect(isSandboxLive('none')).toBe(false);
    expect(isSandboxLive('ended')).toBe(false);
  });
});

describe('resolveDisplayStatus', () => {
  it('given no sandbox and a provision in flight, should report starting', () => {
    // The one status no row can carry: the row is written only once a Sprite
    // exists, so provisioning has no persisted in-flight state to read.
    expect(resolveDisplayStatus({ status: 'none', isProvisioning: true })).toBe('starting');
  });

  it('given no sandbox and nothing in flight, should stay none', () => {
    expect(resolveDisplayStatus({ status: 'none', isProvisioning: false })).toBe('none');
  });

  it('given a RUNNING session, should not downgrade to starting', () => {
    // The row's own fact outranks a request being in flight — re-provisioning a
    // live sandbox must not make the chip look like it is booting.
    expect(resolveDisplayStatus({ status: 'running', isProvisioning: true })).toBe('running');
  });

  it('given an ENDED session, should not resurrect it as starting', () => {
    expect(resolveDisplayStatus({ status: 'ended', isProvisioning: true })).toBe('ended');
  });
});
