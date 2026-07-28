/**
 * load_skill — the model-initiated loader for the unified capability system
 * (Universal Commands + built-in skills).
 *
 * One load path for both sources: built-in skills resolve to code-shipped
 * bodies via the same resolveBuiltinInjection the chip path uses; user/drive
 * commands resolve through resolveCommandInjectionById, i.e. the full
 * hostile-input pipeline (owner/member gate, enabled, trash, use-time
 * canUserViewPage). Every failure degrades to a soft error string — a load
 * must never fail the agent turn.
 *
 * The result is a TOOL RESULT by design (streamText's only mid-stream
 * injection channel; prefix-cache-safe append). It is elidable: stale loads
 * collapse to the standard re-fetchable stub, and the newest load per skill
 * is protected (see tool-result-eliding).
 */

import { tool } from 'ai';
import { z } from 'zod';
import {
  BUILTIN_SKILLS,
  COMMAND_TRIGGER_PATTERN,
  isSkillEligible,
} from '@pagespace/lib/commands/command-core';
import { isUserDriveMember } from '@pagespace/lib/permissions/permissions';
import { loggers } from '@pagespace/lib/logging/logger-config';
import { loadAvailableCommands } from '@/lib/commands/available-commands';
import {
  resolveBuiltinInjection,
  resolveCommandInjectionById,
} from '../core/command-resolver';
import {
  buildSkillLoadResult,
  COMMAND_SKIP_REASON_TEXT,
  type CommandExecutionPlan,
} from '../core/command-processor';
import type { ToolExecutionContext } from '../core/types';

const skillLogger = loggers.ai.child({ module: 'skill-tools' });

const unavailable = (name: string) =>
  `No skill or command named "${name}" is available here. Check the skills list or list_commands for what exists.`;

function planToResult(plan: CommandExecutionPlan, name: string): string {
  if (plan.kind === 'skip') {
    // Same degrade philosophy as chip resolution: reasons are already
    // user-safe copy, and not_found is indistinguishable from no-access.
    return plan.reason === 'not_found'
      ? unavailable(name)
      : `The "${name}" skill could not be loaded — ${COMMAND_SKIP_REASON_TEXT[plan.reason]}.`;
  }
  return buildSkillLoadResult(plan.injection);
}

export const skillTools = {
  load_skill: tool({
    description:
      'Load the full instructions for a skill or command by name (from the SKILLS list, the available commands, or tool_search results). Returns the instruction body as this tool result. Call it BEFORE starting non-trivial work in a skill\'s domain, and call it again if an earlier load was elided from the conversation.',
    inputSchema: z.object({
      name: z
        .string()
        .describe(
          'The skill/command name exactly as listed, e.g. "canvas-websites" or "release-checklist". Lowercase letters, numbers, and hyphens.'
        ),
    }),
    execute: async ({ name }, { experimental_context: context }) => {
      const ctx = context as ToolExecutionContext | undefined;
      const userId = ctx?.userId;
      if (!userId) throw new Error('User authentication required');

      // Shape-validate the hostile name before any lookup.
      if (!COMMAND_TRIGGER_PATTERN.test(name)) return unavailable(name);

      try {
        // Drive context is the caller's knowledge, but membership is not:
        // re-verify before scoping the command list (same contract as the
        // chip resolver — loadAvailableCommands requires a verified id).
        const requestedDriveId = ctx?.locationContext?.currentDrive?.id ?? null;
        const driveId =
          requestedDriveId && (await isUserDriveMember(userId, requestedDriveId))
            ? requestedDriveId
            : null;

        const { winners } = await loadAvailableCommands(userId, driveId);
        const winner = winners.find((command) => command.trigger === name);
        if (!winner) return unavailable(name);

        // Invocation telemetry: load counts per skill drive future catalog
        // ordering/degradation decisions (least-loaded lose descriptions
        // first) and justify each pack's existence.
        skillLogger.info('load_skill invoked', { skill: name, scope: winner.scope });

        if (winner.scope === 'builtin') {
          const definition = BUILTIN_SKILLS.find((skill) => skill.trigger === name);
          if (definition && !isSkillEligible(definition, ctx?.enabledTools ?? undefined)) {
            return `The "${name}" skill applies to tools this agent does not have, so it is not available here.`;
          }
          const plan = await resolveBuiltinInjection(name, userId, { driveId });
          return planToResult(plan, name);
        }

        const plan = await resolveCommandInjectionById(winner.id, userId, name);
        return planToResult(plan, name);
      } catch (error) {
        skillLogger.error('load_skill failed; returning soft error', error as Error, {
          skill: name,
        });
        return `Loading "${name}" failed unexpectedly. Proceed without it or try again.`;
      }
    },
  }),
};
