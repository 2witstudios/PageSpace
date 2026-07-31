import { describe, it, expect } from 'vitest';
import { selectTriggerBudgets } from './trigger-budget';
import type { WorkflowStep } from '@pagespace/db/schema/workflows';

const ai: WorkflowStep = { kind: 'ai', prompt: 'p' };
const insert: WorkflowStep = { kind: 'tool', toolName: 'insert_content', args: {} };
const channel: WorkflowStep = { kind: 'tool', toolName: 'send_channel_message', args: {} };

describe('selectTriggerBudgets', () => {
  it('all-AI: AI budget + credit hold, no deterministic budget', () => {
    expect(selectTriggerBudgets([ai])).toEqual({
      aiBudget: true,
      creditHold: true,
      deterministicBudget: false,
      channelLimit: false,
    });
  });

  it('all-deterministic: deterministic budget only, no hold', () => {
    expect(selectTriggerBudgets([insert])).toEqual({
      aiBudget: false,
      creditHold: false,
      deterministicBudget: true,
      channelLimit: false,
    });
  });

  it('mixed: AI budget + hold (deterministic budget does not stack)', () => {
    expect(selectTriggerBudgets([insert, ai])).toEqual({
      aiBudget: true,
      creditHold: true,
      deterministicBudget: false,
      channelLimit: false,
    });
  });

  it('channel limit applies whenever a send_channel_message tool step exists', () => {
    expect(selectTriggerBudgets([channel]).channelLimit).toBe(true);
    expect(selectTriggerBudgets([channel, ai]).channelLimit).toBe(true);
    expect(selectTriggerBudgets([insert]).channelLimit).toBe(false);
  });
});
