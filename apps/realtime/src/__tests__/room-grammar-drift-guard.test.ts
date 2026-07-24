/**
 * Room-grammar drift guard (#2158).
 *
 * The room-name grammar lives in ONE module — @pagespace/lib/realtime/rooms —
 * consumed by the join sites (src/index.ts), the kick room sets
 * (src/kick-handler.ts), and the broadcast audience validator
 * (src/broadcast-audience.ts). Before this, broadcast-audience hand-maintained
 * a second encoding of the grammar "derived from src/index.ts socket.join
 * calls" with line references that had drifted ~300 lines stale; a new
 * socket.join shape added without updating the validator silently broke
 * broadcasts to it.
 *
 * Two guards:
 * 1. Semantic: every shared room builder's output must be accepted by the
 *    broadcast audience validator. A join site can only produce rooms via the
 *    builders, so this proves broadcasts can address every joinable room.
 * 2. Structural: no realtime source file may construct a room name from a raw
 *    prefix literal (`drive:…`, `activity:…`, …). New room shapes must be
 *    added to the shared grammar module — where the validator picks them up
 *    automatically — not inlined at a join site.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALL_ROOM_BUILDERS } from '@pagespace/lib/realtime/rooms';
import { authorizeBroadcastAudience } from '../broadcast-audience';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const CUID = 'tz4a98xxat96iws9zmbrgj3a';

describe('room grammar drift guard', () => {
  it('every shared room builder output is a broadcastable audience', () => {
    expect(ALL_ROOM_BUILDERS.length).toBeGreaterThan(0);
    for (const build of ALL_ROOM_BUILDERS) {
      const room = build(CUID);
      const result = authorizeBroadcastAudience({ channelId: room, event: 'test:event', payload: {} });
      expect(result, `broadcast-audience rejected joinable room shape ${room}`).toEqual({ allowed: true });
    }
  });

  it('no realtime source constructs a room name outside the shared grammar module', () => {
    // Any room-prefix immediately following a quote or backtick is a
    // hand-rolled room name. Builders from @pagespace/lib/realtime/rooms are
    // the only sanctioned way to construct one.
    const roomLiteral = /[`'"](?:drive|notifications|dm|activity|user):/;

    const offenders: string[] = [];
    for (const entry of readdirSync(SRC_DIR, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const path = join(entry.parentPath, entry.name);
      if (path.includes('__tests__')) continue;

      const source = readFileSync(path, 'utf8')
        // Strip comments so documentation may still NAME the shapes.
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');

      for (const [index, line] of source.split('\n').entries()) {
        if (roomLiteral.test(line)) {
          offenders.push(`${path}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    expect(offenders, `room names must come from @pagespace/lib/realtime/rooms:\n${offenders.join('\n')}`).toEqual([]);
  });
});
