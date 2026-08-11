/**
 * Drift guard between the two declarations of one wire shape.
 *
 * `RealtimeTool` (this app) is what `buildRealtimeTools` produces; the shared
 * `realtimeToolSchema` is what `apps/realtime` validates on arrival. They are
 * deliberately separate declarations — the realtime server must not import from
 * the web app — so the only thing keeping them honest is this file.
 *
 * The check runs against the REAL registry rather than a fixture: a fixture
 * would keep passing after a registry change that the schema rejects, which is
 * the exact failure this exists to catch (a call attaching with zero tools, or
 * a 400 from the attach endpoint, for a reason nobody can see from here).
 */

import { describe, expect, it } from 'vitest';
import {
  realtimeToolSchema,
  realtimeAttachPayloadSchema,
  realtimeSeedEventSchema,
  type RealtimeSeedEventWire,
} from '@pagespace/lib/realtime/voice-bridge-contract';
import { buildRealtimeTools } from '../tools';
import { buildRealtimeSeed, type SeedEvent } from '../seed';
import { buildPageSpaceTools } from '../../core/ai-tools';
import type { RealtimeTool } from '../session';

describe('realtime tool wire shape', () => {
  it('given the real registry, every emitted tool should satisfy the shared schema', () => {
    const tools = buildRealtimeTools(buildPageSpaceTools());
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      const parsed = realtimeToolSchema.safeParse(tool);
      expect(parsed.success, `${tool.name} failed the shared schema`).toBe(true);
    }
  });

  it('should carry the whole registry-built tool set through the attach payload intact', () => {
    const tools = buildRealtimeTools(buildPageSpaceTools());

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
