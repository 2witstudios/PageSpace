// The Messages pane's groups and which of them the viewer folded away.
//
// A group is one drive's channels or the viewer's DMs. Its key is stable
// across routes, so a group folded on one page stays folded on the next, and
// the folded keys are saved to this browser's localStorage. Storage can
// refuse (private windows, blocked site data): then the choice lasts for the
// session.

import type { ChannelThread, MessageThread } from '../message-model/message';

/** The DMs' group, the same on every route. */
export const DIRECT_GROUP = 'direct';

/** A drive's channels group. */
export const driveGroup = (driveId: string): string => `drive:${driveId}`;

export const COLLAPSED_GROUPS_KEY = 'imago:messages-collapsed';

/** Folds an open group, or opens a folded one. */
export const toggleGroup = (collapsed: readonly string[], key: string): readonly string[] =>
  collapsed.includes(key) ? collapsed.filter((entry) => entry !== key) : [...collapsed, key];

/** What localStorage held; anything malformed is nothing folded. */
export const parseCollapsed = (raw: string | null): readonly string[] => {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
};

export const serializeCollapsed = (collapsed: readonly string[]): string => JSON.stringify(collapsed);

/** One drive's channels in an all-drives list. */
export type DriveChannels = {
  readonly driveId: string;
  readonly name: string;
  readonly channels: readonly ChannelThread[];
};

/**
 * The inbox's channels grouped by drive, in the order the drives are listed,
 * each keeping the inbox's newest-first order. A drive the list does not name
 * yet (it is still loading) follows the named ones, in the order its channels came.
 */
export const channelsByDrive = (
  threads: readonly MessageThread[],
  driveNames: ReadonlyMap<string, string>,
): readonly DriveChannels[] => {
  const byDrive = new Map<string, ChannelThread[]>();
  for (const thread of threads) {
    if (thread.kind !== 'channel') continue;
    const rows = byDrive.get(thread.driveId);
    if (rows === undefined) byDrive.set(thread.driveId, [thread]);
    else rows.push(thread);
  }
  const named = [...driveNames.keys()].filter((driveId) => byDrive.has(driveId));
  const unnamed = [...byDrive.keys()].filter((driveId) => !driveNames.has(driveId));
  return [...named, ...unnamed].map((driveId) => ({
    driveId,
    name: driveNames.get(driveId) ?? 'Drive',
    channels: byDrive.get(driveId) ?? [],
  }));
};
