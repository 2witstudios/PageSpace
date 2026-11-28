import { isAgentAccount, withAgentMarker } from '@pagespace/lib/auth/agent/display-name';
import type { Assignee } from './task';

/** A person on the task who is an AI agent account (not an agent page). */
const isAgentAccountAssignee = (entry: Assignee): boolean =>
  entry.type === 'user' && isAgentAccount(entry.accountType);

/**
 * An assignee's name where only text can carry it (an avatar group's
 * accessible name): an AI agent account's self-chosen name gets its plain-text
 * marker, from accountType; a person's or an agent page's name is unchanged.
 */
export const assigneeLabel = (entry: Assignee): string =>
  isAgentAccountAssignee(entry) ? withAgentMarker(entry.name, entry.accountType) : entry.name;
