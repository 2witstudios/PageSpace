import { describe, it, expect } from 'vitest';
import {
  BUILTIN_SKILLS,
  validateCommandDescription,
  validateCommandTrigger,
} from '@pagespace/lib/commands/command-core';
import { getSkillBody } from '../skill-bodies';

/**
 * Size guards follow the Agent Skills authoring guidance: a body is a
 * focused instruction pack (< 500 lines / ~5k tokens), not a reference dump.
 * Level-3 detail belongs in child resources, not the body.
 */
const MAX_BODY_CHARS = 20_000;
const MAX_BODY_LINES = 500;

describe('skill bodies', () => {
  it('every registered builtin skill has a body (registry ↔ body parity)', () => {
    for (const skill of BUILTIN_SKILLS) {
      const body = getSkillBody(skill.trigger);
      expect(body, `missing body for ${skill.trigger}`).toBeTruthy();
    }
  });

  it('unknown triggers return null', () => {
    expect(getSkillBody('nonexistent-skill')).toBeNull();
    expect(getSkillBody('help')).toBeNull();
  });

  it.each(BUILTIN_SKILLS.map((s) => s.trigger))('%s body respects size guards', (trigger) => {
    const body = getSkillBody(trigger)!;
    expect(body.length).toBeLessThan(MAX_BODY_CHARS);
    expect(body.split('\n').length).toBeLessThan(MAX_BODY_LINES);
  });

  it.each(BUILTIN_SKILLS.map((s) => s.trigger))(
    '%s registry entry passes Agent Skills validation',
    (trigger) => {
      const skill = BUILTIN_SKILLS.find((s) => s.trigger === trigger)!;
      expect(validateCommandTrigger(skill.trigger)).toEqual({ valid: true });
      expect(validateCommandDescription(skill.description)).toEqual({ valid: true });
    }
  );

  it.each(BUILTIN_SKILLS.map((s) => s.trigger))('%s body is substantive markdown', (trigger) => {
    const body = getSkillBody(trigger)!;
    // A body that lost its content in a refactor should fail loudly, not
    // ship as an empty instruction pack.
    expect(body.length).toBeGreaterThan(2_000);
    expect(body).toContain('## ');
  });
});
