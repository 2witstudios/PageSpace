import { describe, it, expect } from 'vitest';
import { PLANNING_ASSISTANT_SYSTEM_PROMPT } from '../example-agent-prompts';

describe('example-agent-prompts', () => {
  describe('PLANNING_ASSISTANT_SYSTEM_PROMPT', () => {
    it('is defined and is a non-empty string', () => {
      expect(PLANNING_ASSISTANT_SYSTEM_PROMPT).toBeDefined();
      expect(typeof PLANNING_ASSISTANT_SYSTEM_PROMPT).toBe('string');
      expect(PLANNING_ASSISTANT_SYSTEM_PROMPT.length).toBeGreaterThan(0);
    });

    it('contains the Planning Assistant persona name', () => {
      expect(PLANNING_ASSISTANT_SYSTEM_PROMPT).toContain('Planning Assistant');
    });

    it('mentions PageSpace page types', () => {
      expect(PLANNING_ASSISTANT_SYSTEM_PROMPT).toContain('Folder');
      expect(PLANNING_ASSISTANT_SYSTEM_PROMPT).toContain('Document');
      expect(PLANNING_ASSISTANT_SYSTEM_PROMPT).toContain('Task List');
    });

    it('describes the agent job (planning / organizing)', () => {
      expect(PLANNING_ASSISTANT_SYSTEM_PROMPT).toContain('plan');
    });

    it('includes guidance on how to respond', () => {
      // The prompt includes numbered response steps
      expect(PLANNING_ASSISTANT_SYSTEM_PROMPT).toContain('1.');
    });

    it('mentions structure principles', () => {
      expect(PLANNING_ASSISTANT_SYSTEM_PROMPT).toContain('folder');
    });

    it('is trimmed (no leading or trailing whitespace)', () => {
      expect(PLANNING_ASSISTANT_SYSTEM_PROMPT).toBe(PLANNING_ASSISTANT_SYSTEM_PROMPT.trim());
    });
  });
});
