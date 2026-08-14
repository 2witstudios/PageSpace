/**
 * Drift guard between the two declarations of one wire shape.
 *
 * `RealtimeTool` (this app) is what `toRealtimeTools` produces; the shared
 * `realtimeToolSchema` is what `apps/realtime` validates on arrival. They are
 * deliberately separate declarations — the realtime server must not import from
 * the web app — so the only thing keeping them honest is this file.
 *
 * The check runs against the REAL registry rather than a fixture: a fixture
 * would keep passing after a registry change that the schema rejects, which is
 * the exact failure this exists to catch (a call attaching with zero tools, or
 * a 400 from the attach endpoint, for a reason nobody can see from here).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  voiceBridgeRequestSchema,
  realtimeToolSchema,
  realtimeAttachPayloadSchema,
  realtimeSeedEventSchema,
  type RealtimeSeedEventWire,
} from '@pagespace/lib/realtime/voice-bridge-contract';
import { buildRealtimeToolExposure, toRealtimeTools } from '../tools';
import { handleVoiceBridgeRequest } from '../bridge-handler';
import { buildRealtimeSeed, type SeedEvent } from '../seed';
import { buildPageSpaceTools } from '../../core/ai-tools';
import type { RealtimeTool } from '../session';

describe('realtime tool wire shape', () => {
  it('given the real registry, every emitted tool should satisfy the shared schema', () => {
    const tools = toRealtimeTools(buildRealtimeToolExposure(buildPageSpaceTools()).tools);
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      const parsed = realtimeToolSchema.safeParse(tool);
      expect(parsed.success, `${tool.name} failed the shared schema`).toBe(true);
    }
  });

  it('should carry the whole registry-built tool set through the attach payload intact', () => {
    const tools = toRealtimeTools(buildRealtimeToolExposure(buildPageSpaceTools()).tools);

    const parsed = realtimeAttachPayloadSchema.safeParse({
      callId: 'rtc_u0_abc',
      secret: 'ek_secret',
      userId: 'u1',
      tools,
      model: 'gpt-realtime-2.1',
    });

    expect(parsed.success).toBe(true);
    // Not merely "valid" — unchanged. A schema that silently stripped
    // `parameters` would still parse, and the model would get bare tool names.
    expect(parsed.success && parsed.data.tools).toEqual(tools);
  });

  it('a RealtimeTool should be assignable to the wire type in both directions', () => {
    // Compile-time half of the guard: if either declaration gains or loses a
    // field, one of these assignments stops type-checking.
    const fromApp: RealtimeTool = {
      type: 'function',
      name: 'read_page',
      description: 'Read a page.',
      parameters: { type: 'object', properties: {} },
    };
    const onWire = realtimeToolSchema.parse(fromApp);
    const backToApp: RealtimeTool = onWire;

    expect(backToApp).toEqual(fromApp);
  });

  it('should reject a Chat-Completions-shaped tool, which is the shape that would drift in', () => {
    const nested = {
      type: 'function',
      function: { name: 'read_page', description: 'Read.', parameters: {} },
    };
    expect(realtimeToolSchema.safeParse(nested).success).toBe(false);
  });
});

/**
 * The seed's two declarations, guarded the same way and for a sharper reason:
 * the content-part type differs by role (`input_text` for the user, `text` for
 * the assistant) and getting it wrong is not a validation error on the wire —
 * it is an opaque `error` event on a socket that then just sits there.
 */
describe('realtime seed wire shape', () => {
  const history = [
    { role: 'user', content: 'where are my notes?', createdAt: new Date(1) },
    { role: 'assistant', content: 'In your Inbox.', createdAt: new Date(2) },
  ];

  it('given a built seed, every item should satisfy the shared schema', () => {
    const seed = buildRealtimeSeed(history);
    expect(seed).toHaveLength(2);

    for (const item of seed) {
      expect(realtimeSeedEventSchema.safeParse(item).success).toBe(true);
    }
  });

  it('should carry a built seed through the attach payload unchanged', () => {
    const seed = buildRealtimeSeed(history);

    const parsed = realtimeAttachPayloadSchema.safeParse({
      callId: 'rtc_u0_abc',
      secret: 'ek_secret',
      userId: 'u1',
      model: 'gpt-realtime-2.1',
      seed,
    });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.seed).toEqual(seed);
  });

  it('a SeedEvent should be assignable to the wire type in both directions', () => {
    const fromApp: SeedEvent = {
      type: 'conversation.item.create',
      item: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    };
    const onWire: RealtimeSeedEventWire = realtimeSeedEventSchema.parse(fromApp);
    const backToApp: SeedEvent = onWire;

    expect(backToApp).toEqual(fromApp);
  });

  it('should reject an audio content part — assistant audio cannot be seeded at all', () => {
    expect(
      realtimeSeedEventSchema.safeParse({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'input_audio', text: '' }],
        },
      }).success,
    ).toBe(false);
  });

  it('should reject an item with no content at all', () => {
    expect(
      realtimeSeedEventSchema.safeParse({
        type: 'conversation.item.create',
        item: { type: 'message', role: 'user', content: [] },
      }).success,
    ).toBe(false);
  });
});

/**
 * The request union and the handler that narrows it.
 *
 * `handleVoiceBridgeRequest` used to narrow `kind === 'tool'` and then FALL
 * THROUGH to the transcript write, so a kind added to the schema would have
 * been persisted as a spoken turn — a wrong row, written confidently, with
 * nothing raised anywhere. The handler is exhaustive now; this is what keeps it
 * that way, because the next member will be added by someone who has not read
 * that story.
 */
describe('every request kind is handled', () => {
  const kinds = voiceBridgeRequestSchema.options.map(
    (option) => (option.shape.kind as { value: string }).value,
  );

  it('should know exactly which kinds exist', () => {
    // Fails when a member is added, which is the prompt to handle it below.
    expect(kinds.sort()).toEqual(['tool', 'tool_finished', 'tool_started', 'transcript']);
  });

  it('should route every one of them without falling through to the transcript write', async () => {
    const transcriptDeps = {
      loadConversation: vi.fn(async () => ({
        id: 'conv1',
        userId: 'u1',
        isShared: false,
        type: 'global',
        contextId: null,
        isActive: true,
      })),
      createConversation: vi.fn(),
      canAccess: vi.fn(async () => true),
      saveGlobalMessage: vi.fn(async () => ({ saved: true, rev: 1 })),
      savePageMessage: vi.fn(async () => ({ saved: true, rev: 1 })),
      newMessageId: vi.fn(() => 'm1'),
      logger: { warn: vi.fn() },
    };
    const deps = {
      toolDeps: () => ({ tools: {}, logger: { warn: vi.fn(), error: vi.fn() } }),
      transcriptDeps,
      model: 'gpt-realtime-2.1',
    } as unknown as Parameters<typeof handleVoiceBridgeRequest>[0];

    const base = { callId: 'rtc_1', userId: 'u1', conversationId: 'conv1' };
    const bodies: Record<string, unknown> = {
      tool: { ...base, kind: 'tool', name: 'read_page', argumentsJson: '{}' },
      transcript: { ...base, kind: 'transcript', role: 'assistant', text: 'hello' },
      tool_started: {
        ...base,
        kind: 'tool_started',
        toolCallId: 'call_1',
        name: 'read_page',
        argumentsJson: '{}',
      },
      tool_finished: {
        ...base,
        kind: 'tool_finished',
        toolCallId: 'call_1',
        name: 'read_page',
        argumentsJson: '{}',
        messageId: 'm1',
        output: 'ok',
      },
    };

    for (const kind of kinds) {
      const response = await handleVoiceBridgeRequest(deps, JSON.stringify(bodies[kind]));

      expect(response.status, `${kind} was refused`).toBe(200);
      expect(response.body.ok, `${kind} failed`).toBe(true);
      // The tell for a fallthrough: a kind answered as though it were a transcript.
      if (kind !== 'transcript') {
        expect(
          response.body.ok && response.body.kind,
          `${kind} was answered as a ${response.body.ok ? response.body.kind : ''}`,
        ).not.toBe('transcript');
      }
    }
  });
});
