import { describe, it, expect } from 'vitest';
import {
  isPayloadRef,
  isToolStepComplete,
  isStepsValid,
  synthesizeSteps,
  type WorkflowStep,
  type WorkflowToolStep,
} from '../WorkflowStepsEditor';

describe('isPayloadRef', () => {
  it('recognizes a well-formed payload reference', () => {
    expect(isPayloadRef({ $payload: 'a.b' })).toBe(true);
  });
  it('rejects non-string $payload, arrays, null, and primitives', () => {
    expect(isPayloadRef({ $payload: 1 })).toBe(false);
    expect(isPayloadRef(['x'])).toBe(false);
    expect(isPayloadRef(null)).toBe(false);
    expect(isPayloadRef('text')).toBe(false);
  });
});

describe('isToolStepComplete', () => {
  const insert: WorkflowToolStep = {
    kind: 'tool',
    toolName: 'insert_content',
    args: { pageId: 'p1', anchor: '## Log', position: 'after', content: 'hi' },
  };

  it('is true when every required field has a literal value', () => {
    expect(isToolStepComplete(insert)).toBe(true);
  });

  it('is true when a required field is a payload reference with a non-empty path', () => {
    const step = { ...insert, args: { ...insert.args, content: { $payload: 'issue.title' } } };
    expect(isToolStepComplete(step)).toBe(true);
  });

  it('is false when a required field is missing', () => {
    const step = { ...insert, args: { ...insert.args, content: undefined } };
    expect(isToolStepComplete(step)).toBe(false);
  });

  it('is false when a payload reference path is empty', () => {
    const step = { ...insert, args: { ...insert.args, content: { $payload: '' } } };
    expect(isToolStepComplete(step)).toBe(false);
  });

  it('is false for an unknown tool name', () => {
    expect(isToolStepComplete({ kind: 'tool', toolName: 'trash_drive', args: {} })).toBe(false);
  });

  it('optional fields do not affect completeness', () => {
    const step: WorkflowToolStep = {
      kind: 'tool',
      toolName: 'replace_lines',
      args: { pageId: 'p1', startLine: 1, content: 'x' }, // endLine omitted, optional
    };
    expect(isToolStepComplete(step)).toBe(true);
  });
});

describe('isStepsValid', () => {
  it('is false for an empty chain', () => {
    expect(isStepsValid([])).toBe(false);
  });

  it('is true for a single complete ai step', () => {
    const steps: WorkflowStep[] = [{ kind: 'ai', prompt: 'summarize' }];
    expect(isStepsValid(steps)).toBe(true);
  });

  it('is false when any ai step has a blank prompt', () => {
    const steps: WorkflowStep[] = [{ kind: 'ai', prompt: '   ' }];
    expect(isStepsValid(steps)).toBe(false);
  });

  it('is false when any tool step is incomplete, even if others are complete', () => {
    const steps: WorkflowStep[] = [
      { kind: 'ai', prompt: 'ok' },
      { kind: 'tool', toolName: 'insert_content', args: {} },
    ];
    expect(isStepsValid(steps)).toBe(false);
  });
});

describe('synthesizeSteps', () => {
  it('returns explicit steps verbatim when present', () => {
    const steps: WorkflowStep[] = [{ kind: 'tool', toolName: 'insert_content', args: {} }];
    expect(synthesizeSteps({ steps, prompt: 'ignored', agentPageId: null })).toBe(steps);
  });

  it('synthesizes one ai step for a legacy row', () => {
    const result = synthesizeSteps({ steps: null, prompt: 'legacy prompt', agentPageId: 'agent1' });
    expect(result).toEqual([{ kind: 'ai', prompt: 'legacy prompt', agentPageId: 'agent1' }]);
  });

  it('omits agentPageId when the legacy row has none', () => {
    const result = synthesizeSteps({ steps: null, prompt: 'p', agentPageId: null });
    expect(result).toEqual([{ kind: 'ai', prompt: 'p' }]);
  });

  it('returns an empty chain for a brand-new workflow with nothing set', () => {
    expect(synthesizeSteps({ steps: null, prompt: '', agentPageId: null })).toEqual([]);
  });
});
