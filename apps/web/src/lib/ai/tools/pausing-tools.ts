import type { z } from 'zod';
import { ASK_USER_TOOL_NAME, askUserOutputSchema } from './ask-user-tools';
import { REQUEST_ENV_APPROVAL_TOOL_NAME, requestEnvApprovalOutputSchema } from './env-approval-tools';

/**
 * The client-side tools that PAUSE a turn awaiting a person: execute-less,
 * answered in the chat UI, resumed by merging the client's result into the
 * persisted assistant message. `ask_user` (a question) and
 * `request_env_approval` (the Tier B click, GA wave 2) share every piece of
 * that plumbing — answerability, the optimistic patch, the resume merge, the
 * "resume only once every pending part is answered" predicate — and this
 * module is where the set is defined ONCE, so adding a third never means
 * finding six string comparisons.
 *
 * The two are still different things: an `ask_user` answer is model-visible
 * text; a `request_env_approval` result only REPORTS an authorization that
 * happened elsewhere (the owner's authenticated click, server-signed and
 * machine-verified). Sharing the transport does not make them the same.
 */
export const PAUSING_TOOL_NAMES = [ASK_USER_TOOL_NAME, REQUEST_ENV_APPROVAL_TOOL_NAME] as const;
export type PausingToolName = (typeof PAUSING_TOOL_NAMES)[number];

const PART_TYPES = new Set<string>(PAUSING_TOOL_NAMES.map((name) => `tool-${name}`));

/** `tool-<name>` for a pausing tool; the UIMessage part type. */
export function pausingToolPartType(name: PausingToolName): string {
  return `tool-${name}`;
}

export function isPausingToolPartType(type: string): boolean {
  return PART_TYPES.has(type);
}

export function isPausingToolName(name: string): name is PausingToolName {
  return (PAUSING_TOOL_NAMES as readonly string[]).includes(name);
}

/** The schema the SERVER validates a client-supplied result against before persisting it. */
export function pausingToolOutputSchema(partType: string): z.ZodTypeAny | null {
  if (partType === pausingToolPartType(ASK_USER_TOOL_NAME)) return askUserOutputSchema;
  if (partType === pausingToolPartType(REQUEST_ENV_APPROVAL_TOOL_NAME)) return requestEnvApprovalOutputSchema;
  return null;
}
