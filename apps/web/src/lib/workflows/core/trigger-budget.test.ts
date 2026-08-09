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
      channelPostCount: 0,
    });
  });

  it('all-deterministic: deterministic budget only, no hold', () => {
    expect(selectTriggerBudgets([insert])).toEqual({
      aiBudget: false,
      creditHold: false,
      deterministicBudget: true,
      channelPostCount: 0,
    });
  });

  it('mixed: AI budget + hold (deterministic budget does not stack)', () => {
    expect(selectTriggerBudgets([insert, ai])).toEqual({
      aiBudget: true,
      creditHold: true,
      deterministicBudget: false,
      channelPostCount: 0,
    });
  });

  it('channelPostCount counts every send_channel_message step, not just whether one exists', () => {
    expect(selectTriggerBudgets([channel]).channelPostCount).toBe(1);
    expect(selectTriggerBudgets([channel, channel, channel]).channelPostCount).toBe(3);
    expect(selectTriggerBudgets([channel, ai, channel]).channelPostCount).toBe(2);
    expect(selectTriggerBudgets([insert]).channelPostCount).toBe(0);
  });
});
