/**
 * Code-shipped skill bodies, keyed by builtin trigger (Universal Commands
 * registry, kind: 'skill'). Server-only: bodies are markdown instruction
 * packs sized for on-demand loading (guard-tested < 500 lines / < 20k chars
 * each), and live here rather than in @pagespace/lib so client bundles that
 * import command-core never carry them.
 *
 * Registry ↔ body parity is enforced by skill-bodies.test.ts: every
 * BUILTIN_SKILLS trigger has a body here and vice versa.
 */

import { CANVAS_WEBSITES_SKILL_BODY } from './bodies/canvas-websites';
import { SPREADSHEETS_SKILL_BODY } from './bodies/spreadsheets';
import { TASK_MANAGEMENT_SKILL_BODY } from './bodies/task-management';
import { WRITING_DOCUMENTS_SKILL_BODY } from './bodies/writing-documents';

const SKILL_BODIES: Readonly<Record<string, string>> = {
  'canvas-websites': CANVAS_WEBSITES_SKILL_BODY,
  spreadsheets: SPREADSHEETS_SKILL_BODY,
  'task-management': TASK_MANAGEMENT_SKILL_BODY,
  'writing-documents': WRITING_DOCUMENTS_SKILL_BODY,
};

/** The instruction body for a builtin skill trigger, or null when unknown. */
export function getSkillBody(trigger: string): string | null {
  return SKILL_BODIES[trigger] ?? null;
}
