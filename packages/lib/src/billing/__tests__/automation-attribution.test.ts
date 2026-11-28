import { describe, it, expect } from 'vitest';
import { automationRefFor, encodeAutomationRef, parseAutomationRef } from '../automation-attribution';
import { automationSpend, driveSpend, personTriggeredSpend, PERSONAL_SPEND } from '../spend-target';

describe('automationRefFor', () => {
  it('SPEND-10 (partial) a run no person is present for is attributed to its workflow', () => {
    expect(automationRefFor(automationSpend('d1'), 'wf-1')).toBe('workflow:wf-1');
  });

  it("SPEND-10 (partial) a person's action (a manual Run, a channel mention) and a person's own call stay theirs", () => {
    expect(automationRefFor(personTriggeredSpend('d1'), 'wf-1')).toBeUndefined();
    expect(automationRefFor(driveSpend('d1'), 'wf-1')).toBeUndefined();
    expect(automationRefFor(PERSONAL_SPEND, 'wf-1')).toBeUndefined();
  });

  it('names nothing without a workflow id', () => {
    expect(automationRefFor(automationSpend('d1'), undefined)).toBeUndefined();
    expect(automationRefFor(automationSpend('d1'), '')).toBeUndefined();
  });
});

describe('the automation reference codec', () => {
  it('SPEND-10 (partial) a workflow and a Zoom connection round-trip through one codec, each by its kind', () => {
    for (const ref of [{ kind: 'workflow', workflowId: 'wf-1' }, { kind: 'zoom', connectionId: 'zc-1' }] as const) {
      expect(parseAutomationRef(encodeAutomationRef(ref))).toEqual(ref);
    }
    expect(encodeAutomationRef({ kind: 'zoom', connectionId: 'zc-1' })).toBe('zoom:zc-1');
  });

  it('reads nothing it did not write: a bare id, an empty id, an unknown kind, null', () => {
    for (const stored of ['wf-1', 'workflow:', 'zoom:', 'github:x', '', null, undefined]) {
      expect(parseAutomationRef(stored), String(stored)).toBeNull();
    }
  });
});
