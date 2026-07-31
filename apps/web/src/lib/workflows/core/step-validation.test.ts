import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateToolStep, validateSteps, stepsRequirePayload } from './step-validation';
import type { WorkflowStep, WorkflowToolStep } from '@pagespace/db/schema/workflows';

const ALLOWLIST = ['insert_content', 'send_channel_message'] as const;
const SCHEMAS = {
  insert_content: z.object({
    pageId: z.string(),
    anchor: z.string(),
    content: z.string(),
    position: z.enum(['before', 'after']),
  }),
  send_channel_message: z.object({ pageId: z.string(), content: z.string() }),
};

const opts = { allowlist: ALLOWLIST, schemas: SCHEMAS };

const validStatic: WorkflowToolStep = {
  kind: 'tool',
  toolName: 'insert_content',
  args: { pageId: 'p1', anchor: '## Log', content: 'hello', position: 'after' },
};

describe('validateToolStep', () => {
  it('accepts a ref-free step whose args parse against the schema (fully validated)', () => {
    const result = validateToolStep(validStatic, opts);
    expect(result).toEqual({ ok: true, refs: [], fullyValidated: true });
  });

  it('rejects tool names outside the allowlist', () => {
    const result = validateToolStep({ ...validStatic, toolName: 'trash_drive' }, opts);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('trash_drive');
  });

  it('rejects allowlisted names that have no schema entry (registry drift)', () => {
    const result = validateToolStep(
      { ...validStatic, toolName: 'send_channel_message' },
      { allowlist: ALLOWLIST, schemas: { insert_content: SCHEMAS.insert_content } }
    );
    expect(result.ok).toBe(false);
  });

  it('rejects ref-free args that fail schema parse', () => {
    const result = validateToolStep(
      { ...validStatic, args: { ...validStatic.args, position: 'sideways' } },
      opts
    );
    expect(result.ok).toBe(false);
  });

  it('skips full parse when refs are present, but validates ref path syntax', () => {
    const step: WorkflowToolStep = {
      ...validStatic,
      args: { ...validStatic.args, content: { $payload: 'issue.title' } },
    };
    const result = validateToolStep(step, opts);
    expect(result).toEqual({ ok: true, refs: ['issue.title'], fullyValidated: false });
  });

  it('rejects refs with invalid path syntax even when other args are fine', () => {
    const step: WorkflowToolStep = {
      ...validStatic,
      args: { ...validStatic.args, content: { $payload: 'a..b' } },
    };
    expect(validateToolStep(step, opts).ok).toBe(false);
  });

  it('rejects forbidden segments in ref paths', () => {
    const step: WorkflowToolStep = {
      ...validStatic,
      args: { ...validStatic.args, content: { $payload: '__proto__.x' } },
    };
    expect(validateToolStep(step, opts).ok).toBe(false);
  });
});

describe('validateSteps', () => {
  const ai: WorkflowStep = { kind: 'ai', prompt: 'summarize' };

  it('accepts a mixed chain when ai steps have an effective agent', () => {
    const result = validateSteps([validStatic, ai], { ...opts, workflowAgentPageId: 'agent1' });
    expect(result.ok).toBe(true);
  });

  it('rejects empty step lists', () => {
    expect(validateSteps([], { ...opts, workflowAgentPageId: null }).ok).toBe(false);
  });

  it('rejects chains longer than the cap', () => {
    const many = Array.from({ length: 21 }, () => validStatic);
    expect(validateSteps(many, { ...opts, workflowAgentPageId: null }).ok).toBe(false);
  });

  it('rejects an ai step with no step-level or workflow-level agent', () => {
    const result = validateSteps([ai], { ...opts, workflowAgentPageId: null });
    expect(result.ok).toBe(false);
  });

  it('accepts an ai step whose agent comes from the step itself', () => {
    const result = validateSteps(
      [{ kind: 'ai', prompt: 'p', agentPageId: 'agent2' }],
      { ...opts, workflowAgentPageId: null }
    );
    expect(result.ok).toBe(true);
  });

  it('rejects ai steps with empty prompts', () => {
    const result = validateSteps(
      [{ kind: 'ai', prompt: '  ', agentPageId: 'agent2' }],
      { ...opts, workflowAgentPageId: null }
    );
    expect(result.ok).toBe(false);
  });

  it('surfaces the failing step index in the error', () => {
    const bad = { ...validStatic, toolName: 'nope' };
    const result = validateSteps([validStatic, bad], { ...opts, workflowAgentPageId: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('step 2');
  });
});

describe('stepsRequirePayload', () => {
  it('is true when any tool step contains a $payload ref', () => {
    const step: WorkflowToolStep = {
      ...validStatic,
      args: { nested: [{ deep: { $payload: 'a.b' } }] },
    };
    expect(stepsRequirePayload([step])).toBe(true);
  });

  it('is false for static chains', () => {
    expect(stepsRequirePayload([validStatic, { kind: 'ai', prompt: 'p' }])).toBe(false);
  });
});
