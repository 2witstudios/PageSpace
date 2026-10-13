import type { AgentSessionRow } from './agents-data';

/** The minimum an environment needs to name its group. */
export interface EnvRosterEntry {
  readonly id: string;
  readonly name: string;
  readonly substrate: 'sprite' | 'local';
}

/** One group in the pane: an environment, the sessions inside it, or the loose sessions. */
export interface SessionGroup {
  /** Stable key: the env id, or `orphan` / `loose`. */
  readonly key: string;
  readonly envId: string | null;
  readonly name: string;
  /** Null for the orphan and loose groups, which have no substrate to show. */
  readonly substrate: EnvRosterEntry['substrate'] | null;
  readonly sessions: readonly AgentSessionRow[];
}

export const LOOSE_GROUP_NAME = 'Sessions';
export const ORPHAN_GROUP_NAME = 'Unavailable environment';

export const substrateLabel = (substrate: EnvRosterEntry['substrate']): string =>
  substrate === 'local' ? 'Local' : 'Sprite';

/**
 * Groups sessions by the environment they run in. The environment roster is
 * the authority on which groups exist, so an environment with no sessions
 * still shows. A session naming an environment the roster lacks is kept in an
 * orphan group rather than dropped; sessions with no environment are loose.
 */
export function groupSessionsByEnv(
  sessions: readonly AgentSessionRow[],
  envs: readonly EnvRosterEntry[],
): SessionGroup[] {
  const known = new Set(envs.map((env) => env.id));
  const groups: SessionGroup[] = envs.map((env) => ({
    key: env.id,
    envId: env.id,
    name: env.name,
    substrate: env.substrate,
    sessions: sessions.filter((session) => session.envId === env.id),
  }));
  const orphans = sessions.filter((session) => session.envId !== null && !known.has(session.envId));
  if (orphans.length > 0) {
    groups.push({ key: 'orphan', envId: null, name: ORPHAN_GROUP_NAME, substrate: null, sessions: orphans });
  }
  const loose = sessions.filter((session) => session.envId === null);
  if (loose.length > 0) {
    groups.push({ key: 'loose', envId: null, name: LOOSE_GROUP_NAME, substrate: null, sessions: loose });
  }
  return groups;
}

/** Case-insensitive match on the session name. A blank query matches everything. */
export function filterSessions(sessions: readonly AgentSessionRow[], query: string): AgentSessionRow[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...sessions];
  return sessions.filter((session) => session.name.toLowerCase().includes(needle));
}

/** "just now", "42 min ago", "3 h ago", "2 d ago". */
export function agoLabel(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** The host of a published app's URL, or the raw value when it does not parse. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
