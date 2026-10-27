import { describe, it, expect } from 'vitest';
import { isPausingToolName, isPausingToolPartType, PAUSING_TOOL_NAMES, pausingToolOutputSchema, pausingToolPartType } from '../pausing-tools';

describe('pausing tools — the set defined once', () => {
  it('is exactly ask_user and request_env_approval', () => {
    expect([...PAUSING_TOOL_NAMES]).toEqual(['ask_user', 'request_env_approval']);
    expect(isPausingToolName('ask_user')).toBe(true);
    expect(isPausingToolName('request_env_approval')).toBe(true);
    expect(isPausingToolName('finish')).toBe(false);
  });

  it('recognises both part types and nothing else', () => {
    expect(isPausingToolPartType(pausingToolPartType('ask_user'))).toBe(true);
    expect(isPausingToolPartType('tool-request_env_approval')).toBe(true);
    expect(isPausingToolPartType('tool-execute_tool')).toBe(false);
    expect(isPausingToolPartType('text')).toBe(false);
  });

  it('gives each its own output schema, and none for anything else', () => {
    expect(pausingToolOutputSchema('tool-ask_user')?.safeParse({ dismissed: true, reason: 'x' }).success).toBe(true);
    expect(pausingToolOutputSchema('tool-ask_user')?.safeParse({ challengeId: 'c', outcome: 'allowed' }).success).toBe(false);
    expect(pausingToolOutputSchema('tool-request_env_approval')?.safeParse({ challengeId: 'c', outcome: 'allowed' }).success).toBe(true);
    expect(pausingToolOutputSchema('tool-request_env_approval')?.safeParse({ dismissed: true, reason: 'x' }).success).toBe(false);
    expect(pausingToolOutputSchema('tool-bash')).toBeNull();
  });
});
