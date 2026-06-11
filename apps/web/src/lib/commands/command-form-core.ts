/**
 * Universal Commands — pure form-validation state machine and copy for the
 * settings UI (spec §3.3, §10). Mirrors the server rules by importing them
 * from @pagespace/lib/commands/command-core (never duplicating the regex);
 * the copy here is the UI-facing wording from the spec, which intentionally
 * differs from the lib's API-facing error strings.
 */

import {
  COMMAND_TRIGGER_PATTERN,
  COMMAND_TRIGGER_MAX_LENGTH,
  COMMAND_DESCRIPTION_MAX_LENGTH,
  isReservedTrigger,
} from '@pagespace/lib/commands/command-core';

export type CommandFormScope = 'personal' | 'drive';

export type CommandErrorCode =
  | 'E1'
  | 'E2'
  | 'E3'
  | 'E4'
  | 'E5'
  | 'E6'
  | 'E7'
  | 'E8'
  | 'E9'
  | 'E10';

export interface CommandFieldError {
  code: CommandErrorCode;
  message: string;
}

export interface TriggerValidationContext {
  scope: CommandFormScope;
  /** Triggers already taken in the same scope, excluding the command being edited. */
  existingTriggers: readonly string[];
}

/** Live input normalization (spec §10): lowercase, spaces become hyphens. */
export function normalizeTriggerInput(raw: string): string {
  return raw.toLowerCase().replace(/\s/g, '-');
}

export function validateTriggerValue(
  trigger: string,
  context: TriggerValidationContext
): CommandFieldError | null {
  if (trigger.length === 0) {
    return { code: 'E1', message: 'Trigger is required.' };
  }
  if (trigger.length > COMMAND_TRIGGER_MAX_LENGTH) {
    return {
      code: 'E2',
      message: `Trigger must be ${COMMAND_TRIGGER_MAX_LENGTH} characters or fewer.`,
    };
  }
  if (trigger.startsWith('-') || trigger.endsWith('-')) {
    return { code: 'E4', message: "Trigger can't start or end with a hyphen." };
  }
  if (trigger.includes('--')) {
    return { code: 'E5', message: "Trigger can't contain consecutive hyphens." };
  }
  if (!COMMAND_TRIGGER_PATTERN.test(trigger)) {
    return {
      code: 'E3',
      message: 'Trigger can only contain lowercase letters, numbers, and hyphens.',
    };
  }
  if (isReservedTrigger(trigger)) {
    return {
      code: 'E7',
      message: `/${trigger} is reserved for a built-in command. Choose a different trigger.`,
    };
  }
  if (context.existingTriggers.includes(trigger)) {
    return {
      code: 'E6',
      message:
        context.scope === 'personal'
          ? `You already have a command named /${trigger}.`
          : `This drive already has a command named /${trigger}.`,
    };
  }
  return null;
}

export function validateDescriptionValue(description: string): CommandFieldError | null {
  if (description.trim().length === 0) {
    return { code: 'E8', message: 'Description is required.' };
  }
  if (description.length > COMMAND_DESCRIPTION_MAX_LENGTH) {
    return { code: 'E9', message: 'Description must be 1,024 characters or fewer.' };
  }
  return null;
}

export function validateEntryPageValue(entryPageId: string | null): CommandFieldError | null {
  if (!entryPageId) {
    return { code: 'E10', message: 'Choose an entry page for this command.' };
  }
  return null;
}

export interface CommandFormValues {
  trigger: string;
  description: string;
  entryPageId: string | null;
}

export interface CommandFormErrors {
  trigger?: CommandFieldError;
  description?: CommandFieldError;
  entryPage?: CommandFieldError;
}

export function computeFormErrors(
  values: CommandFormValues,
  context: TriggerValidationContext
): CommandFormErrors {
  const errors: CommandFormErrors = {};
  const trigger = validateTriggerValue(values.trigger, context);
  if (trigger) errors.trigger = trigger;
  const description = validateDescriptionValue(values.description);
  if (description) errors.description = description;
  const entryPage = validateEntryPageValue(values.entryPageId);
  if (entryPage) errors.entryPage = entryPage;
  return errors;
}

export function isSaveBlocked(errors: CommandFormErrors): boolean {
  return Boolean(errors.trigger || errors.description || errors.entryPage);
}

// ---------------------------------------------------------------------------
// W1 — advisory size warning (never blocks save)
// ---------------------------------------------------------------------------

export const SIZE_ADVISORY_TOKEN_LIMIT = 5000;
export const SIZE_ADVISORY_LINE_LIMIT = 500;

export interface PageSize {
  tokens: number;
  lines: number;
}

/** Rough size estimate: ~4 characters per token, newline-delimited lines. */
export function computePageSize(content: string): PageSize {
  return {
    tokens: Math.round(content.length / 4),
    lines: content.length === 0 ? 0 : content.split('\n').length,
  };
}

export function sizeAdvisory(content: string): string | null {
  const { tokens, lines } = computePageSize(content);
  if (tokens <= SIZE_ADVISORY_TOKEN_LIMIT && lines <= SIZE_ADVISORY_LINE_LIMIT) {
    return null;
  }
  const formattedTokens = tokens.toLocaleString('en-US');
  const formattedLines = lines.toLocaleString('en-US');
  return `This page is large (about ${formattedTokens} tokens / ${formattedLines} lines). Commands work best when the entry page stays under ~5,000 tokens / 500 lines — move details into child pages, which the AI reads on demand.`;
}

// ---------------------------------------------------------------------------
// W2 — cross-scope shadow notice (advisory)
// ---------------------------------------------------------------------------

export function shadowNotice(trigger: string, collidingDriveNames: readonly string[]): string | null {
  if (collidingDriveNames.length === 0) return null;
  return `This will shadow the drive command /${trigger} in ${collidingDriveNames.join(', ')}. Your personal command will run instead.`;
}

// ---------------------------------------------------------------------------
// API payload builders
// ---------------------------------------------------------------------------

export interface CommandPayloadValues {
  trigger: string;
  description: string;
  entryPageId: string;
  enabled: boolean;
}

export interface CreateCommandPayload extends CommandPayloadValues {
  driveId?: string;
}

export function buildCreatePayload(
  values: CommandPayloadValues,
  driveId: string | null
): CreateCommandPayload {
  return {
    trigger: values.trigger,
    description: values.description,
    entryPageId: values.entryPageId,
    enabled: values.enabled,
    ...(driveId ? { driveId } : {}),
  };
}

export function buildUpdatePayload(
  original: CommandPayloadValues,
  values: CommandPayloadValues
): Partial<CommandPayloadValues> {
  const payload: Partial<CommandPayloadValues> = {};
  if (values.trigger !== original.trigger) payload.trigger = values.trigger;
  if (values.description !== original.description) payload.description = values.description;
  if (values.entryPageId !== original.entryPageId) payload.entryPageId = values.entryPageId;
  if (values.enabled !== original.enabled) payload.enabled = values.enabled;
  return payload;
}

// ---------------------------------------------------------------------------
// Exact UI copy (spec §3.1, §3.4, §4.2)
// ---------------------------------------------------------------------------

export function toggleToast(trigger: string, enabled: boolean): string {
  return `Command /${trigger} ${enabled ? 'enabled' : 'disabled'}`;
}

export const TOGGLE_FAILED_TOAST = 'Failed to update command';

export function saveToast(trigger: string, isEdit: boolean): string {
  return `Command /${trigger} ${isEdit ? 'updated' : 'created'}`;
}

export const SAVE_FAILED_TOAST = 'Failed to save command';

export function deleteToast(trigger: string): string {
  return `Command /${trigger} deleted`;
}

export function deleteDialogTitle(trigger: string): string {
  return `Delete /${trigger}?`;
}

export const DELETE_DIALOG_BODY: Record<CommandFormScope, string> = {
  personal:
    'This removes the command for you. Pages are not deleted. Messages that already used this command keep their chip but show it as removed.',
  drive:
    'This removes the command for everyone in this drive. Pages are not deleted. Messages that already used this command keep their chip but show it as removed.',
};

export const EMPTY_STATE_TITLE = 'No commands yet';

export const EMPTY_STATE_SUBTEXT: Record<CommandFormScope, string> = {
  personal:
    "Commands let you inject a page's knowledge into any AI conversation by typing /its-name.",
  drive: 'Drive commands are available to everyone in this drive.',
};

export const ENTRY_PAGE_UNAVAILABLE_BADGE = 'Entry page unavailable';

export const ENTRY_PAGE_UNAVAILABLE_TOOLTIP =
  "The entry page for this command is in the trash or you've lost access to it. The command is skipped until this is fixed.";

export const PERSONAL_SHADOW_TOOLTIP =
  'This command shadows a drive command with the same trigger.';

export const DRIVE_READONLY_NOTICE = 'Only drive owners and admins can manage drive commands.';
