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
  workspaceId: null,
  ownerId: OWNER,
  isShared,
  triggeredBy: { userId: OWNER, browserSessionId: 'bs-1' },
});

const globalCtx: ConversationEmitContext = {
  conversationId: CONVERSATION,
  rev: 3,
  scope: { kind: 'global', ownerId: OWNER },
  workspaceId: 'wsabc123',
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

let capturedTargets: Array<{ channelId: string; event: string }>;

beforeEach(() => {
  capturedTargets = [];
  vi.stubEnv('INTERNAL_REALTIME_URL', 'http://realtime.test');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse(init?.body ?? '{}') as { channelId: string; event: string };
      capturedTargets.push({ channelId: body.channelId, event: body.event });
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
  messageDeleted: (ctx) => conversationEvents.messageDeleted(ctx, 'msgabc123'),
  undoApplied: (ctx) =>
    conversationEvents.undoApplied(ctx, { mode: 'messages_only', affectedMessageIds: ['msgabc123'] }),
  created: (ctx) =>
    conversationEvents.created(ctx, {
      id: CONVERSATION,
      title: null,
      type: 'page',
      contextId: PAGE,
      workspaceId: null,
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
});

describe('emit-site containment (source scan)', () => {
  it('no file outside conversation-events.ts emits a conversation:* socket event', () => {
    const SRC_ROOT = path.resolve(__dirname, '../../..');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          if (full.endsWith(`websocket${path.sep}conversation-events.ts`)) continue;
          const content = fs.readFileSync(full, 'utf8');
          // An emission is a broadcast body naming a conversation:* event —
          // client-side *listeners* (`socket.on('conversation:*')`) are fine.
          if (/event:\s*['"`]conversation:/.test(content)) {
            offenders.push(path.relative(SRC_ROOT, full));
          }
        }
      }
    };
    walk(SRC_ROOT);
    expect(offenders).toEqual([]);
  });
});
