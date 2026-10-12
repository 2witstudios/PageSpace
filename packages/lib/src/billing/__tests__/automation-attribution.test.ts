import { describe, it, expect } from 'vitest';
import { automationWorkflowIdFor, isZoomTranscriptsAutomationRef, zoomTranscriptsAutomationRef } from '../automation-attribution';
import { automationSpend, driveSpend, personTriggeredSpend, PERSONAL_SPEND } from '../spend-target';

describe('automationWorkflowIdFor', () => {
  it('SPEND-10 (partial) a run no person is present for is attributed to its workflow', () => {
    expect(automationWorkflowIdFor(automationSpend('d1'), 'wf-1')).toBe('wf-1');
  });

  it("SPEND-10 (partial) a person's action (a manual Run, a channel mention) and a person's own call stay theirs", () => {
    expect(automationWorkflowIdFor(personTriggeredSpend('d1'), 'wf-1')).toBeUndefined();
    expect(automationWorkflowIdFor(driveSpend('d1'), 'wf-1')).toBeUndefined();
    expect(automationWorkflowIdFor(PERSONAL_SPEND, 'wf-1')).toBeUndefined();
  });

  it('names nothing without a workflow id', () => {
    expect(automationWorkflowIdFor(automationSpend('d1'), undefined)).toBeUndefined();
    expect(automationWorkflowIdFor(automationSpend('d1'), '')).toBeUndefined();
  });
});

describe('zoomTranscriptsAutomationRef', () => {
  it('SPEND-10 (partial) a Zoom connection\'s enrichment has its own automation reference, never mistaken for a workflow id', () => {
    const ref = zoomTranscriptsAutomationRef('zc-1');
    expect(isZoomTranscriptsAutomationRef(ref)).toBe(true);
    expect(isZoomTranscriptsAutomationRef('wf-1')).toBe(false);
  });
});
