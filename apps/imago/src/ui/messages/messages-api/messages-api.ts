// The messaging routes apps/web already has, read through imago's API client
// (the session cookie on every request, apps/web's errors as ApiError).
// Access is decided there: these lists are whatever the server answers.

import type { ApiClient } from '@/api/client';
import type {
  ChannelThread,
  ConversationsResponse,
  DirectThread,
  InboxResponse,
} from '../message-model/message';
import { channelThreadsFrom, directThreadsFrom } from '../message-model/from-api';

const segment = encodeURIComponent;

/** The most either route returns in one page (its parseBoundedIntParam max). */
const PAGE_SIZE = 100;

/** A page limit, so a server that never stops saying hasMore cannot spin this. */
const MAX_PAGES = 10;

const withCursor = (path: string, cursor: string | undefined) =>
  cursor === undefined ? path : `${path}&cursor=${segment(cursor)}`;

export const messagePaths = {
  /** A drive's CHANNEL pages with the viewer's unread counts, newest post first. */
  driveChannels: (driveId: string, cursor?: string) =>
    withCursor(`/api/inbox?type=channel&driveId=${segment(driveId)}&limit=${PAGE_SIZE}`, cursor),
  /** The viewer's DM conversations, newest message first. */
  conversations: (cursor?: string) => withCursor(`/api/messages/conversations?limit=${PAGE_SIZE}`, cursor),
  /** The viewer's unread totals across every drive. */
  badges: '/api/sidebar/badges',
};

/** Every page of a cursor-paged route, up to MAX_PAGES. */
const allPages = async <Page, Row>(
  load: (cursor: string | undefined) => Promise<Page>,
  read: (page: Page) => { rows: readonly Row[]; next: string | null },
): Promise<readonly Row[]> => {
  let rows: readonly Row[] = [];
  let cursor: string | undefined;
  for (let pages = 0; pages < MAX_PAGES; pages += 1) {
    const page = read(await load(cursor));
    rows = [...rows, ...page.rows];
    if (page.next === null) break;
    cursor = page.next;
  }
  return rows;
};

/** A drive's channels from GET /api/inbox, every page. */
export const fetchDriveChannels = async (client: ApiClient, driveId: string): Promise<readonly ChannelThread[]> =>
  channelThreadsFrom(
    driveId,
    await allPages(
      (cursor) => client.apiFetch<InboxResponse>(messagePaths.driveChannels(driveId, cursor)),
      ({ items, pagination }) => ({ rows: items, next: pagination.hasMore ? pagination.nextCursor : null }),
    ),
  );

/** The viewer's DMs from GET /api/messages/conversations, every page. */
export const fetchDirectThreads = async (client: ApiClient): Promise<readonly DirectThread[]> =>
  directThreadsFrom(
    await allPages(
      (cursor) => client.apiFetch<ConversationsResponse>(messagePaths.conversations(cursor)),
      ({ conversations, pagination }) => ({
        rows: conversations,
        next: pagination.hasMore ? pagination.nextCursor : null,
      }),
    ),
  );
