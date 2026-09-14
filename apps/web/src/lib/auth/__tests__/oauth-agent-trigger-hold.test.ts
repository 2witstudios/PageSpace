import { describe, it, expect } from 'vitest';
import { appliesAgentTriggerHold, calendarPatchTriggerIntent, refuseOAuthAgentTrigger, taskPatchTriggerIntent } from '../oauth-agent-trigger-hold';
import { mcpDriveKey, oauthDriveGrant } from './oauth-principal-fixture';
import type { AuthResult } from '../index';

const session: AuthResult = { tokenType: 'session', sessionId: 's', userId: 'u', role: 'user', tokenVersion: 0, adminRoleVersion: 0 };

describe('refuseOAuthAgentTrigger (point-guard hold pending Phase 2b / [D-15])', () => {
  it('refuses an OAuth principal whose input would create or fire an agent trigger, with a constant 403', async () => {
    for (const intent of [{ writesTrigger: true, firesTrigger: false }, { writesTrigger: false, firesTrigger: true }]) {
      const res = refuseOAuthAgentTrigger(oauthDriveGrant('drivex', 'admin'), intent);
      expect(res?.status).toBe(403);
      expect(await res!.json()).toEqual({ error: 'Agent triggers are not available to OAuth applications' });
    }
  });

  it('lets an OAuth principal through when the input carries no trigger', () => {
    expect(refuseOAuthAgentTrigger(oauthDriveGrant('drivex', 'admin'), { writesTrigger: false, firesTrigger: false })).toBeNull();
  });

  it('applies to OAuth principals only', () => {
    expect(appliesAgentTriggerHold(oauthDriveGrant('drivex'))).toBe(true);
    expect(appliesAgentTriggerHold(mcpDriveKey('drivex'))).toBe(false);
    expect(appliesAgentTriggerHold(session)).toBe(false);
  });

  it('never changes what an mcp_ key or a session may do', () => {
    for (const principal of [mcpDriveKey('drivex'), session]) {
      expect(refuseOAuthAgentTrigger(principal, { writesTrigger: true, firesTrigger: true })).toBeNull();
    }
  });
});

describe('taskPatchTriggerIntent', () => {
  const none = new Set<'due_date' | 'completion'>();
  const base = { agentTriggerPresent: false, dueDateChanged: false, statusMovedToDone: false, armed: none };
  it.each([
    ['agentTrigger present', { ...base, agentTriggerPresent: true }, { writesTrigger: true, firesTrigger: false }],
    ['due date changed, armed due-date trigger', { ...base, dueDateChanged: true, armed: new Set(['due_date'] as const) }, { writesTrigger: true, firesTrigger: false }],
    ['due date changed, only a completion trigger armed', { ...base, dueDateChanged: true, armed: new Set(['completion'] as const) }, { writesTrigger: false, firesTrigger: false }],
    ['completed, armed completion trigger', { ...base, statusMovedToDone: true, armed: new Set(['completion'] as const) }, { writesTrigger: false, firesTrigger: true }],
    ['completed, armed due-date trigger', { ...base, statusMovedToDone: true, armed: new Set(['due_date'] as const) }, { writesTrigger: false, firesTrigger: true }],
    ['completed, nothing armed', { ...base, statusMovedToDone: true }, { writesTrigger: false, firesTrigger: false }],
    ['title-only edit', base, { writesTrigger: false, firesTrigger: false }],
  ] as const)('%s', (_label, input, expected) => {
    expect(taskPatchTriggerIntent(input)).toEqual(expected);
  });
});

describe('calendarPatchTriggerIntent', () => {
  it.each([
    ['agentTrigger present', { agentTriggerPresent: true, timingChanged: false, eventHasTrigger: false }, true],
    ['re-timed, event carries a trigger', { agentTriggerPresent: false, timingChanged: true, eventHasTrigger: true }, true],
    ['re-timed, no trigger', { agentTriggerPresent: false, timingChanged: true, eventHasTrigger: false }, false],
    ['title-only edit on an event with a trigger', { agentTriggerPresent: false, timingChanged: false, eventHasTrigger: true }, false],
  ] as const)('%s', (_label, input, writes) => {
    expect(calendarPatchTriggerIntent(input)).toEqual({ writesTrigger: writes, firesTrigger: false });
  });
});
