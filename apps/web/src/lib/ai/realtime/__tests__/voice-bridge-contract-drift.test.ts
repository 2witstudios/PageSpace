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
} from '@pagespace/lib/realtime/voice-bridge-contract';
import { buildRealtimeTools } from '../tools';
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
