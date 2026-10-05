'use client';

// The open DM: the shared thread (thread/use-thread) on the conversation's
// routes and realtime room. Messages from the other person arrive as
// `new_dm_message`; opening the conversation marks it read as it loads.

import { useThread } from '../thread/use-thread';
import { dmThread } from './dm-api';

export type UseDmThreadOptions = {
  readonly conversationId: string;
  readonly viewerId: string;
  readonly markReadDelayMs?: number;
  /** The clock a sending post is stamped with until apps/web stores it. */
  readonly now?: () => Date;
};

export const useDmThread = ({ conversationId, ...options }: UseDmThreadOptions) =>
  useThread(dmThread, { threadId: conversationId, ...options });
