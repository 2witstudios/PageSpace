import { isAgentAccount, modelContextUserLabel } from '@pagespace/lib/auth/agent/display-name';

/**
 * Another user's name as it enters a model's context (Agent Signup Phase 2c),
 * for surfaces that already hold a display string with their own fallback
 * (an email prefix, "Someone", or null when the email stays the identity).
 *
 * The marker comes from the live `users.accountType`, never the name: an agent
 * is labelled and its self-chosen name quoted as data by
 * `modelContextUserLabel`; anything else — a human, or an erased actor with no
 * user row — passes through byte-identical, null and undefined included
 * (an absent field stays absent in a tool's JSON).
 */
export function modelContextName<T extends string | null | undefined>(
  name: T,
  accountType: string | null | undefined,
): T | string {
  return isAgentAccount(accountType) ? modelContextUserLabel({ name, accountType }) : name;
}
