// Where the viewer is standing when they send, as apps/web's /api/ai/chat
// reads it: a reference the server resolves and permission-checks at request
// time (apps/web/src/lib/ai/shared/buildContextRef.ts), never names or paths
// the client claims. Derived from the stage, which the URL alone decides, so
// /imago/[driveId]/files/[pageId] names that page in that drive.

import type { Stage } from '../../frame/stage/stage';
import { isDashboard } from '../../frame/drives/home-scope';

export type ContextRefRouteType = 'page' | 'channel' | 'drive' | 'dm' | 'other';

/** The `contextRef` field of a POST /api/ai/chat body. */
export type ContextRef = {
  readonly routeType: ContextRefRouteType;
  readonly pageId?: string;
  readonly driveId?: string;
  readonly dmConversationId?: string;
};

/**
 * The context ref for a stage: the open object, else the drive, else nothing.
 * Home's aggregate sections are the dashboard, so they claim no drive and the
 * server answers with every drive the viewer can reach, as classic's did.
 */
export const contextRefFor = (stage: Stage, homeDriveId: string | null = null): ContextRef => {
  const { driveId, section, object } = stage;
  if (object?.kind === 'conversation') return { routeType: 'dm', dmConversationId: object.conversationId };
  if (driveId === null) return { routeType: 'other' };
  if (object?.kind === 'page') {
    // Classic names a channel by its page alone (buildContextRef's 'channel').
    return section === 'messages'
      ? { routeType: 'channel', pageId: object.pageId }
      : { routeType: 'page', pageId: object.pageId, driveId };
  }
  if (isDashboard(stage, homeDriveId)) return { routeType: 'other' };
  return { routeType: 'drive', driveId };
};
