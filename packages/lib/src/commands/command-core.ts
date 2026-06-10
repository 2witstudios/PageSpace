/**
 * Universal Commands — core validation, registry, and precedence resolution.
 *
 * A command implements the Agent Skills open standard (agentskills.io): the
 * entry page is the SKILL.md (eagerly injected at execution) and its direct
 * child pages are the discoverable resources. This module is pure (no I/O) so
 * both the API routes and future UI/context-engine consumers share one source
 * of truth.
 */

/** Where a command lives. Collision precedence: builtin > user > drive. */
export type CommandScope = 'builtin' | 'user' | 'drive';

/**
 * v1 ships 'document' only; 'prompt_template' and 'builtin' are reserved for
 * later phases.
 */
export type CommandType = 'document' | 'prompt_template' | 'builtin';

export interface CommandSummary {
  id: string;
  trigger: string;
  description: string;
  scope: CommandScope;
  type: CommandType;
  entryPageId?: string;
  driveId?: string;
  enabled?: boolean;
  /** Set on a precedence winner that hides a lower-precedence command. */
  shadows?: CommandScope;
}

export interface BuiltinCommandDefinition {
  trigger: string;
  description: string;
}

/**
 * Built-in command registry. Phase 1 only reserves the triggers; execution of
 * built-ins arrives in a later phase.
 */
export const BUILTIN_COMMANDS: readonly BuiltinCommandDefinition[] = [
  {
    trigger: 'help',
    description: 'List the commands available here and explain how to use them.',
  },
];

/**
 * Triggers that user/drive commands may never claim. Creation with a reserved
 * trigger is rejected outright (built-ins always win collisions anyway).
 */
export const RESERVED_TRIGGERS: ReadonlySet<string> = new Set(
  BUILTIN_COMMANDS.map((command) => command.trigger)
);

export function isReservedTrigger(trigger: string): boolean {
  return RESERVED_TRIGGERS.has(trigger);
}

/** Agent Skills 'name' rules: lowercase alphanumeric + single hyphens. */
export const COMMAND_TRIGGER_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const COMMAND_TRIGGER_MAX_LENGTH = 64;
export const COMMAND_DESCRIPTION_MAX_LENGTH = 1024;

export type CommandValidationResult = { valid: true } | { valid: false; error: string };

/**
 * Validate a command trigger against the Agent Skills 'name' rules: 1-64
 * chars, lowercase alphanumeric and hyphens only, no leading/trailing/
 * consecutive hyphens.
 */
export function validateCommandTrigger(trigger: unknown): CommandValidationResult {
  if (typeof trigger !== 'string') {
    return { valid: false, error: 'Trigger must be a string' };
  }
  if (trigger.length === 0) {
    return { valid: false, error: 'Trigger must not be empty' };
  }
  if (trigger.length > COMMAND_TRIGGER_MAX_LENGTH) {
    return {
      valid: false,
      error: `Trigger must be ${COMMAND_TRIGGER_MAX_LENGTH} characters or less`,
    };
  }
  if (!COMMAND_TRIGGER_PATTERN.test(trigger)) {
    return {
      valid: false,
      error:
        'Trigger must be lowercase letters, numbers, and hyphens, with no leading, trailing, or consecutive hyphens',
    };
  }
  return { valid: true };
}

/**
 * Validate a command description: required, 1-1024 chars (Agent Skills spec).
 * Write it as "what it does + when to use it".
 */
export function validateCommandDescription(description: unknown): CommandValidationResult {
  if (typeof description !== 'string') {
    return { valid: false, error: 'Description must be a string' };
  }
  if (description.trim().length === 0) {
    return { valid: false, error: 'Description must not be empty' };
  }
  if (description.length > COMMAND_DESCRIPTION_MAX_LENGTH) {
    return {
      valid: false,
      error: `Description must be ${COMMAND_DESCRIPTION_MAX_LENGTH} characters or less`,
    };
  }
  return { valid: true };
}

export interface ResolvedCommands {
  /** One command per trigger, highest precedence wins, ordered builtin > user > drive. */
  winners: CommandSummary[];
  /** Commands hidden by a higher-precedence command with the same trigger. */
  shadowed: CommandSummary[];
}

/**
 * Merge built-in, user, and drive commands into a single suggestion list.
 * For each trigger the highest-precedence command wins; winners that hide a
 * lower-precedence command carry `shadows` with the hidden command's scope.
 */
export function resolveCommandPrecedence(
  builtins: readonly CommandSummary[],
  userCommands: readonly CommandSummary[],
  driveCommands: readonly CommandSummary[]
): ResolvedCommands {
  const winners: CommandSummary[] = [];
  const shadowed: CommandSummary[] = [];
  const winnerByTrigger = new Map<string, CommandSummary>();

  for (const tier of [builtins, userCommands, driveCommands]) {
    for (const command of tier) {
      const winner = winnerByTrigger.get(command.trigger);
      if (winner) {
        if (winner.shadows === undefined) {
          winner.shadows = command.scope;
        }
        shadowed.push({ ...command });
      } else {
        const copy = { ...command };
        winnerByTrigger.set(command.trigger, copy);
        winners.push(copy);
      }
    }
  }

  return { winners, shadowed };
}
