import { describe, it, expect } from 'vitest';
import {
  resolveSteps,
  hasAiStep,
  planStepStatuses,
  MAX_WORKFLOW_STEPS,
} from './step-plan';
import type { WorkflowStep } from '@pagespace/db/schema/workflows';

const aiStep: WorkflowStep = { kind: 'ai', prompt: 'do the thing' };
const toolStep: WorkflowStep = { kind: 'tool', toolName: 'insert_content', args: {} };

describe('resolveSteps', () => {
  it('returns explicit steps when present', () => {
    const wf = { steps: [toolStep, aiStep], prompt: '', agentPageId: null };
    expect(resolveSteps(wf)).toEqual([toolStep, aiStep]);
  });

  it('synthesizes a single ai step for legacy rows (steps null)', () => {
    const wf = { steps: null, prompt: 'legacy prompt', agentPageId: 'agent1' };
    expect(resolveSteps(wf)).toEqual([
      { kind: 'ai', prompt: 'legacy prompt', agentPageId: 'agent1' },
    ]);
  });

  it('synthesizes for empty steps arrays too (defensive)', () => {
    const wf = { steps: [], prompt: 'p', agentPageId: 'agent1' };
    expect(resolveSteps(wf)).toEqual([{ kind: 'ai', prompt: 'p', agentPageId: 'agent1' }]);
  });

  it('omits agentPageId in the synthesized step when the column is null', () => {
    const wf = { steps: null, prompt: 'p', agentPageId: null };
    const steps = resolveSteps(wf);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toEqual({ kind: 'ai', prompt: 'p' });
  });
});

describe('hasAiStep', () => {
  it('detects ai steps in a mix', () => {
    expect(hasAiStep([toolStep, aiStep])).toBe(true);
  });
  it('is false for all-deterministic chains', () => {
    expect(hasAiStep([toolStep, toolStep])).toBe(false);
  });
  it('is false for empty lists', () => {
    expect(hasAiStep([])).toBe(false);
  });
});

describe('planStepStatuses (fail-fast transitions)', () => {
  it('all success when no failure', () => {
    expect(planStepStatuses(3, null)).toEqual(['success', 'success', 'success']);
  });

  it('marks the failed step error and everything after skipped', () => {
    expect(planStepStatuses(4, 1)).toEqual(['success', 'error', 'skipped', 'skipped']);
  });

  it('failure at the first step skips all the rest', () => {
    expect(planStepStatuses(3, 0)).toEqual(['error', 'skipped', 'skipped']);
  });

  it('failure at the last step skips nothing', () => {
    expect(planStepStatuses(2, 1)).toEqual(['success', 'error']);
  });
});

describe('MAX_WORKFLOW_STEPS', () => {
  it('is 20', () => {
    expect(MAX_WORKFLOW_STEPS).toBe(20);
  });
});
