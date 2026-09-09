/**
 * AUDIENCE INVARIANT (Agent-Session SSoT epic, Phase 2 — the PR's acceptance
 * bar, per the epic plan's "Risks" section):
 *
 *   No conversation event may reach a WIDER audience than the pre-change
 *   behavior, except the owner's own devices.
 *
 * Pre-change audience per conversation:
 *   - private conversation: nobody (broadcasts were gated on isShared) —
 *     except the owner's own open panes via their own HTTP responses;
 *   - shared page conversation: the page room's members.
 *
 * Post-change audience, per event, must therefore be a subset of:
 *   { owner's own sockets }  ∪  { page-room members, ONLY when isShared }
 *
 * which in room terms means every emission targets ONLY:
 *   - `conv:<conversationId>`      — membership is authz: join_conversation
 *     admits the owner, or (isShared AND page access) via
 *     canAccessConversation; un-share kicks non-owners;
 *   - `user:<ownerId>:sessions`    — the owner's own sockets by construction
 *     (auto-joined per authenticated connection);
 *   - the page room (bare pageId)  — ONLY when the conversation isShared.
 *
 * These tests capture every transport call the emitter module makes (it is
 * the ONLY module that emits `conversation:*` events — pinned by the
 * source-scan test at the bottom) and assert the target-room set, for every
 * event type, in both the private and shared configurations.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@pagespace/lib/auth/broadcast-auth', () => ({
  createSignedBroadcastHeaders: vi.fn(() => ({ 'Content-Type': 'application/json' })),
}));

vi.mock('@pagespace/lib/logging/logger-browser', () => ({
  browserLoggers: {
    realtime: {
      child: vi.fn(() => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() })),
    },
  },
}));

vi.mock('@pagespace/lib/utils/environment', () => ({
  isNodeEnvironment: vi.fn(() => true),
}));

import fs from 'fs';
import { CONVERSATION_EVENTS } from '@pagespace/lib/realtime/conversation-event-names';
import path from 'path';
import type { UIMessage } from 'ai';
import {
  conversationEvents,
  directoryRoomsFor,
  contentRoomsFor,
  shapeMessageForEvent,
  MAX_INLINE_MESSAGE_BYTES,
  type ConversationEmitContext,
} from '../conversation-events';

const OWNER = 'ownerabc123';
const CONVERSATION = 'convabc123';
const PAGE = 'pageabc123';

const ctxFor = (isShared: boolean): ConversationEmitContext => ({
  conversationId: CONVERSATION,
  rev: 7,
  scope: { kind: 'page', pageId: PAGE },
  ownerId: OWNER,
  isShared,
  triggeredBy: { userId: OWNER, browserSessionId: 'bs-1' },
});

const globalCtx: ConversationEmitContext = {
  conversationId: CONVERSATION,
  rev: 3,
  scope: { kind: 'global', ownerId: OWNER },
  ownerId: OWNER,
  isShared: false,
  triggeredBy: { userId: OWNER, browserSessionId: 'bs-1' },
};

const message = { id: 'msgabc123', role: 'user', parts: [{ type: 'text', text: 'hi' }] } as unknown as UIMessage;

/** The invariant's allowed room set for a given configuration. */
const allowedRooms = (isShared: boolean): Set<string> => {
  const rooms = new Set([`conv:${CONVERSATION}`, `user:${OWNER}:sessions`]);
  if (isShared) rooms.add(PAGE);
  return rooms;
};

let capturedTargets: Array<{ channelId: string; event: string; payload: unknown }>;

beforeEach(() => {
  capturedTargets = [];
  vi.stubEnv('INTERNAL_REALTIME_URL', 'http://realtime.test');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { channelId: string; event: string; payload: unknown };
      // The PAYLOAD is kept, not discarded (security review, MEDIUM): a suite
      // that records only {channelId, event} cannot notice a future emitter
      // putting message content into a directory event.
      capturedTargets.push({ channelId: body.channelId, event: body.event, payload: body.payload });
      return { ok: true } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/**
 * Every emitter method — the complete emit surface of the module. Any new
 * method added to conversationEvents fails the completeness check below
 * until it is enumerated (and thereby audience-checked) here.
 */
const EMITTERS: Record<string, (ctx: ConversationEmitContext) => Promise<void>> = {
  messageCreated: (ctx) => conversationEvents.messageCreated(ctx, message, new Date()),
  messageUpdated: (ctx) => conversationEvents.messageUpdated(ctx, message, new Date()),
  messageDeleted: (ctx) => conversationEvents.messageDeleted(ctx, 'msgabc123', new Date()),
  undoApplied: (ctx) =>
    conversationEvents.undoApplied(
      ctx,
      { mode: 'messages_only', affectedMessageIds: ['msgabc123'] },
      new Date(),
    ),
  created: (ctx) =>
    conversationEvents.created(ctx, {
      id: CONVERSATION,
      title: null,
      type: 'page',
      contextId: PAGE,
      isShared: ctx.isShared,
      createdAt: new Date().toISOString(),
      lastMessageAt: null,
    }),
  updated: (ctx) => conversationEvents.updated(ctx, { title: 't' }),
  closed: (ctx) => conversationEvents.closed(ctx),
  reopened: (ctx) => conversationEvents.reopened(ctx),
  deleted: (ctx) => conversationEvents.deleted(ctx),
  streamLifecycleMirror: (ctx) =>
    conversationEvents.streamLifecycleMirror(ctx.conversationId, 'chat:stream_start', {}),
};

describe('audience invariant — every emitter, every configuration', () => {
  it('enumerates EVERY method the emitter module exposes (completeness guard)', () => {
    const methods = Object.keys(conversationEvents).filter(
      (k) => typeof (conversationEvents as Record<string, unknown>)[k] === 'function',
    );
    expect(new Set(Object.keys(EMITTERS))).toEqual(new Set(methods));
  });

  for (const [name, emit] of Object.entries(EMITTERS)) {
    it(`${name}: PRIVATE conversation → rooms ⊆ {conv room, owner sessions room}; never the page room`, async () => {
      await emit(ctxFor(false));
      expect(capturedTargets.length).toBeGreaterThan(0);
      for (const t of capturedTargets) {
        expect(allowedRooms(false).has(t.channelId), `${t.event} leaked to ${t.channelId}`).toBe(true);
      }
      expect(capturedTargets.map((t) => t.channelId)).not.toContain(PAGE);
    });

    it(`${name}: SHARED conversation → rooms ⊆ {conv room, owner sessions room, page room}`, async () => {
      await emit(ctxFor(true));
      for (const t of capturedTargets) {
        expect(allowedRooms(true).has(t.channelId), `${t.event} leaked to ${t.channelId}`).toBe(true);
      }
    });
  }

  it('global-scope events never target any page room (no page exists to share through)', async () => {
    await conversationEvents.messageCreated(globalCtx, message, new Date());
    await conversationEvents.updated(globalCtx, { title: 't' });
    for (const t of capturedTargets) {
      expect([`conv:${CONVERSATION}`, `user:${OWNER}:sessions`]).toContain(t.channelId);
    }
  });

  it('content-plane events target EXACTLY the conv room (pure check)', () => {
    expect(contentRoomsFor(CONVERSATION)).toEqual([`conv:${CONVERSATION}`]);
  });

  it('directory rooms: owner sessions always; page room only when shared AND page-scoped (pure check)', () => {
    expect(directoryRoomsFor({ ownerId: OWNER, isShared: false, scope: { kind: 'page', pageId: PAGE } }))
      .toEqual([`user:${OWNER}:sessions`]);
    expect(directoryRoomsFor({ ownerId: OWNER, isShared: true, scope: { kind: 'page', pageId: PAGE } }))
      .toEqual([`user:${OWNER}:sessions`, PAGE]);
    expect(directoryRoomsFor({ ownerId: OWNER, isShared: true, scope: { kind: 'global', ownerId: OWNER } }))
      .toEqual([`user:${OWNER}:sessions`]);
  });
});

describe('payload shaping', () => {
  it('inlines a message at or under the cap', () => {
    const shaped = shapeMessageForEvent(message);
    expect('message' in shaped && shaped.message).toBeTruthy();
  });

  it('degrades an oversized message to an id-level ref with truncated: true', () => {
    const big = {
      id: 'msgbig123',
      role: 'assistant',
      status: 'complete',
      createdAt: new Date('2026-01-01'),
      parts: [{ type: 'text', text: 'x'.repeat(MAX_INLINE_MESSAGE_BYTES + 1024) }],
    } as unknown as UIMessage & { status: string; createdAt: Date };
    const shaped = shapeMessageForEvent(big);
    expect(shaped).toEqual({
      messageRef: {
        id: 'msgbig123',
        role: 'assistant',
        status: 'complete',
        createdAt: new Date('2026-01-01').toISOString(),
      },
      truncated: true,
    });
  });

  /**
   * A MISSING TIMESTAMP IS OMITTED, NEVER FABRICATED (review finding).
   *
   * This used to fall back to `new Date().toISOString()`, which reads as a
   * tidy default and is the one answer certain to be wrong: `createdAt` is the
   * key clients order on, and this shape is reached by OVERSIZED messages —
   * exactly where a backfill or a replay shows up. Stamping "now" on one puts
   * it at the bottom of a transcript it belongs in the middle of. Absent is a
   * fact a reader can act on.
   */
  it('omits createdAt entirely when the message has none, rather than stamping "now"', () => {
    const big = {
      id: 'msgnodate',
      role: 'assistant',
      status: 'complete',
      parts: [{ type: 'text', text: 'x'.repeat(MAX_INLINE_MESSAGE_BYTES + 1024) }],
    } as unknown as UIMessage & { status: string };
    const shaped = shapeMessageForEvent(big);

    expect(shaped).toEqual({
      messageRef: { id: 'msgnodate', role: 'assistant', status: 'complete' },
      truncated: true,
    });
    // Not merely undefined — the key is absent, so a consumer distinguishing
    // "no timestamp" from "timestamp is undefined" gets the same answer either
    // way, and nothing serializes a null ordering key onto the wire.
    expect('messageRef' in shaped && 'createdAt' in shaped.messageRef).toBe(false);
  });
});

/**
 * PAYLOAD SHAPE, not just audience (security review, MEDIUM).
 *
 * The audience assertions above answer "which rooms?" — but the harness used
 * to record `{channelId, event}` and throw the payload away, so an emitter
 * that started putting message CONTENT into a directory event would have
 * stayed green. Rooms and payloads are one invariant, so assert both.
 */
describe('content never rides a directory event', () => {
  /** Keys that mean "this payload carries conversation content". */
  const CONTENT_KEYS = ['message', 'messageRef', 'parts', 'content'];

  const carriesContent = (payload: unknown): boolean =>
    typeof payload === 'object' &&
    payload !== null &&
    CONTENT_KEYS.some((key) => key in (payload as Record<string, unknown>));

  for (const [name, emit] of Object.entries(EMITTERS)) {
    for (const isShared of [false, true]) {
      it(`${name} (${isShared ? 'shared' : 'private'}): a content-bearing payload targets ONLY the conv room`, async () => {
        await emit(ctxFor(isShared));
        for (const t of capturedTargets) {
          if (!carriesContent(t.payload)) continue;
          expect(
            t.channelId,
            `${t.event} carried content to ${t.channelId}, which is not the content room`,
          ).toBe(`conv:${CONVERSATION}`);
        }
      });
    }
  }

  it('the directory bump reports only metadata — never the message that caused it', async () => {
    await conversationEvents.messageCreated(ctxFor(true), message, new Date());
    const directory = capturedTargets.filter((t) => t.channelId !== `conv:${CONVERSATION}`);
    expect(directory.length).toBeGreaterThan(0);
    for (const t of directory) {
      expect(carriesContent(t.payload), `${t.event} leaked content to ${t.channelId}`).toBe(false);
    }
  });
});

/**
 * The directory bump is what the sidebar sorts on, so a delete that reports
 * `lastMessageAt: null` does not mean "unchanged" — it means "oldest possible".
 * `touchConversationInCache` sorts null as -Infinity, so these two events used
 * to drop a busy conversation to the bottom of the list on a single message
 * delete. They now carry the conversation's RECOMPUTED sort key, like every
 * other content event does.
 */
describe('a delete reports the surviving sort key, not null', () => {
  const surviving = new Date('2024-06-01T12:00:00.000Z');

  const directoryChanges = () =>
    capturedTargets
      .filter((t) => t.event === 'conversation:updated')
      .map((t) => (t.payload as { changes?: { lastMessageAt?: string | null } }).changes);

  it('messageDeleted carries the newest surviving message', async () => {
    await conversationEvents.messageDeleted(ctxFor(true), 'msgabc123', surviving);
    const changes = directoryChanges();
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) expect(c?.lastMessageAt).toBe(surviving.toISOString());
  });

  it('undoApplied carries the newest surviving message', async () => {
    await conversationEvents.undoApplied(
      ctxFor(true),
      { mode: 'messages_only', affectedMessageIds: ['msgabc123'] },
      surviving,
    );
    const changes = directoryChanges();
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) expect(c?.lastMessageAt).toBe(surviving.toISOString());
  });

  it('still reports null when the delete left no messages at all', async () => {
    await conversationEvents.messageDeleted(ctxFor(true), 'msgabc123', null);
    const changes = directoryChanges();
    expect(changes.length).toBeGreaterThan(0);
    for (const c of changes) expect(c?.lastMessageAt).toBeNull();
  });
});

/**
 * THE BROADCAST EMIT-SITE REGISTRY — widened from a `conversation:`-only scan
 * of `apps/web/src` to EVERY broadcast emitter in the repo (security review,
 * MEDIUM).
 *
 * The old scan matched `event: 'conversation:...'` and walked `apps/web/src`
 * only. The agent-workspace broadcasts and the `chat:*`
 * literals in socket-utils.ts were therefore outside its universe entirely —
 * which is precisely why HIGH 1's labelled-grid broadcast was never
 * audience-reviewed. A scan whose universe excludes the emitters that matter
 * is not a guard.
 *
 * So the guard is now an inventory: every file that builds a broadcast body
 * (it mentions `channelId` and names an event literal) must be registered
 * here with the events it emits. Adding an emitter — or a new event to an
 * existing one — fails this test until someone writes it down, and writing it
 * down is the moment to ask who the room's audience is and whether the
 * payload may reach them.
 */
describe('broadcast emit-site registry (repo-wide source scan)', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
  const ROOTS = ['apps', 'packages'];
  const SKIP_DIR = new Set(['node_modules', 'dist', '.next', '.turbo', 'coverage', '__tests__', 'build', 'out']);
  const EVENT_LITERAL = /event:\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;

  /** file → the event names it broadcasts. Sorted; template literals kept verbatim. */
  const REGISTERED: Record<string, string[]> = {
    // --- the conversation content/directory plane (this module) -------------
    // Its `conversation:*` names are passed as arguments, so only the literal
    // mirror event appears in source.
    'apps/web/src/lib/websocket/conversation-events.ts': ['chat:stream_start'],
    // --- the agent-session layout plane -------------------------------------
    // TWO audiences, and both are deliberate:
    //   `session:<id>` — every member of a shared workspace at once, joined
    //     only while that workspace's grid is mounted;
    //   `user:<ownerId>:sessions` — the OWNER's own directory plane, joined
    //     automatically at connect, so a pane placed in a workspace nobody is
    //     looking at still reaches their sidebar instead of waiting for a poll.
    // Both payloads are LABEL-FREE for the same reason (security review HIGH 1):
    // a room has no viewer to redact for. There is deliberately no third room —
    // `drive:<id>` would be a workspace-enumeration oracle, since drive members
    // may reach a workspace they are never shown in a listing.
    'apps/web/src/lib/websocket/agent-workspace-events.ts': ['workspace:nodes-updated'],
    // --- the pre-epic surfaces ----------------------------------------------
    'apps/web/src/lib/websocket/calendar-events.ts': ['calendar', 'calendar:${payload.operation}'],
    'apps/web/src/lib/websocket/socket-utils.ts': [
      'activity',
      'activity:logged',
      'agent:grant_changed',
      'ai_stream_complete',
      'ai_stream_start',
      'chat:conversation_added',
      'chat:conversation_deleted',
      'chat:conversation_renamed',
      'chat:global_conversation_added',
      'chat:message_deleted',
      'chat:message_edited',
      'chat:stream_complete',
      'chat:stream_start',
      'chat:undo_applied',
      'chat:user_message',
      'credits',
      'credits:${payload.operation}',
      'drive',
      'drive:${payload.operation}',
      'drive_member',
      'inbox',
      'inbox:${payload.operation}',
      'page',
      'page:${payload.operation}',
      'shell_activity',
      'task',
      'thread_reply_count_updated',
    ],
    'apps/web/src/app/api/ai/chat/messages/[messageId]/undo/route.ts': ['message_deleted'],
    'apps/web/src/app/api/channels/[pageId]/messages/route.ts': ['new_message'],
    'apps/web/src/app/api/channels/[pageId]/messages/[messageId]/route.ts': ['message_deleted', 'message_edited'],
    'apps/web/src/app/api/channels/[pageId]/messages/[messageId]/reactions/route.ts': [
      'reaction_added',
      'reaction_removed',
    ],
    'apps/web/src/app/api/messages/[conversationId]/route.ts': ['new_dm_message'],
    'apps/web/src/app/api/messages/[conversationId]/[messageId]/route.ts': ['message_deleted', 'message_edited'],
    'apps/web/src/app/api/messages/[conversationId]/[messageId]/reactions/route.ts': [
      'reaction_added',
      'reaction_removed',
    ],
    'apps/web/src/lib/ai/tools/channel-tools.ts': ['message_deleted', 'new_message'],
    'apps/web/src/lib/channels/agent-mention-responder.ts': ['new_message'],
    'packages/lib/src/billing/credit-emit.ts': ['credits:updated'],
    'packages/lib/src/notifications/notifications.ts': ['notification:new'],
    'packages/lib/src/services/page-webhook-service.ts': ['new_message'],
  };

  const scanEmitSites = (): Record<string, string[]> => {
    const found: Record<string, string[]> = {};
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || SKIP_DIR.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) continue;
        if (/\.(test|spec)\.tsx?$/.test(entry.name) || /\.d\.ts$/.test(entry.name)) continue;
        const content = fs.readFileSync(full, 'utf8');
        // A broadcast body is `{ channelId, event, payload }` — requiring
        // `channelId` in the file is what separates real emitters from the
        // many unrelated `event:` fields (Capacitor typings, log metadata).
        if (!content.includes('channelId')) continue;
        const events = new Set<string>();
        for (const match of content.matchAll(EVENT_LITERAL)) events.add(match[2]);
        if (events.size > 0) {
          found[path.relative(REPO_ROOT, full).split(path.sep).join('/')] = [...events].sort();
        }
      }
    };
    for (const root of ROOTS) {
      const full = path.join(REPO_ROOT, root);
      if (fs.existsSync(full)) walk(full);
    }
    return found;
  };

  it('every broadcast emitter in apps/ and packages/ is registered, with exactly the events it emits', () => {
    expect(scanEmitSites()).toEqual(REGISTERED);
  });

  it('no file outside conversation-events.ts emits a conversation:* event', () => {
    const offenders = Object.entries(scanEmitSites())
      .filter(([file]) => file !== 'apps/web/src/lib/websocket/conversation-events.ts')
      .filter(([, events]) => events.some((event) => event.startsWith('conversation:')))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});

/**
 * EVERY EMITTED NAME HAS A LISTENER.
 *
 * The audience suite above proves emissions go to the right ROOMS. This proves
 * they go by the right NAMES — the other half of "the event arrived".
 *
 * The names now come from one shared const (`CONVERSATION_EVENTS` in
 * packages/lib), so emitter and listener cannot spell them differently. But a
 * shared const does not stop someone adding an event nobody subscribes to, or
 * deleting the last listener for one still being emitted; both are silent, and
 * invisible to any test that mocks the transport. So this scans the real client
 * sources for `socket.on(...)` and requires a subscriber per name.
 */
describe('every conversation event a client can receive is subscribed', () => {
  const WEB_SRC = path.resolve(__dirname, '../../..');
  const LISTENER_FILES = [
    'hooks/useConversationSubscription.ts',
    'lib/realtime/session-directory-listener.ts',
  ];

  const subscribedNames = (): Set<string> => {
    const found = new Set<string>();
    for (const rel of LISTENER_FILES) {
      const source = fs.readFileSync(path.join(WEB_SRC, rel), 'utf8');
      for (const match of source.matchAll(/socket\.on\(\s*CONVERSATION_EVENTS\.(\w+)/g)) {
        found.add(match[1]);
      }
    }
    return found;
  };

  it('has a client subscriber for every name in CONVERSATION_EVENTS', () => {
    const subscribed = subscribedNames();
    const unsubscribed = Object.keys(CONVERSATION_EVENTS).filter((key) => !subscribed.has(key));
    expect(
      unsubscribed,
      `emitted with no client listener: ${unsubscribed.join(', ')}. Either wire one up, ` +
        'or delete the event — an emission nobody hears is a silent no-op.',
    ).toEqual([]);
  });

  it('subscribes to nothing that is not an emitted name', () => {
    const known = new Set(Object.keys(CONVERSATION_EVENTS));
    const unknown = [...subscribedNames()].filter((key) => !known.has(key));
    expect(unknown, `listening for names nothing emits: ${unknown.join(', ')}`).toEqual([]);
  });
});
