/**
 * Starter skills — skills that ship as REAL PAGES in the user's Home drive and
 * are registered as personal commands, rather than as code-shipped built-ins.
 *
 * The distinction is ownership, not implementation. A built-in skill
 * (see BUILTIN_SKILLS in command-core) teaches PageSpace's own mechanics: how a
 * CANVAS page works, what SUBTASKS_INCOMPLETE means. Users have no reason to
 * edit those, and a deploy is the right way to change them. A starter skill is
 * *methodology* — how to plan, how to research — where the useful thing is that
 * the user can disagree with it and rewrite it. So it is seeded once and then
 * belongs to them: edits here never reach an existing install.
 *
 * IMPORTANT: this module and its bodies are SERVER-ONLY. They live in
 * packages/lib because three consumers need them (web provisioning, admin
 * provisioning, the backfill script) — not because they are shared with the
 * client. `command-core.ts` in this same directory IS client-imported, which is
 * why the built-in bodies were kept out of lib; do not import this module from
 * a client component or those bodies land in the browser bundle.
 */

import { PLAN_STARTER_SKILL_BODY } from './starter-bodies/plan';

export interface StarterSkillDefinition {
  /** Slash trigger; must satisfy the Agent Skills name rules (validateCommandTrigger). */
  trigger: string;
  /** Title of the installed page. */
  title: string;
  /**
   * The command description. Kept short on purpose: a personal command rides
   * the VOLATILE `AVAILABLE COMMANDS` block, which has a char budget and
   * degrades to shorter clips when exceeded. Long starter descriptions would
   * push the user's own commands down the degradation ladder.
   */
  description: string;
  /** Markdown seeded as the page content — the skill body. */
  body: string;
}

/** Root folder in Home that holds installed starter skill pages. */
export const STARTER_SKILLS_FOLDER_TITLE = 'Skills';

export const STARTER_SKILLS: readonly StarterSkillDefinition[] = [
  {
    trigger: 'plan',
    title: 'Plan',
    description:
      'Research a multi-step request, write a reviewable plan document, and get agreement before making changes. Use before non-trivial work.',
    body: PLAN_STARTER_SKILL_BODY,
  },
];

export const STARTER_SKILL_TRIGGERS: readonly string[] = STARTER_SKILLS.map((s) => s.trigger);
