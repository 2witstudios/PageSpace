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

// Any room-prefix immediately following a quote or backtick is a hand-rolled
// room name. Builders from @pagespace/lib/realtime/rooms are the only
// sanctioned way to construct one.
const ROOM_LITERAL = /[`'"](?:drive|notifications|dm|activity|user):/;

/**
 * Pure scan of one file's source for hand-rolled room-name literals, given
 * its already-read contents. Comments are stripped first so documentation may
 * still NAME the shapes without tripping the guard. Extracted from the
 * directory walk below so both the "true" (offense found) and "false" (clean
 * source) branches are exercised directly, not just incidentally by whichever
 * shape the real source tree happens to be in.
 */
function findRoomLiteralOffenses(path: string, rawSource: string): string[] {
  const source = rawSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  const offenses: string[] = [];
  for (const [index, line] of source.split('\n').entries()) {
    if (ROOM_LITERAL.test(line)) {
      offenses.push(`${path}:${index + 1}: ${line.trim()}`);
    }
  }
  return offenses;
}

describe('findRoomLiteralOffenses (pure scanner)', () => {
  it('flags a hand-rolled room literal', () => {
    const offenses = findRoomLiteralOffenses('fixture.ts', "const room = `drive:${driveId}`;");
    expect(offenses).toEqual(['fixture.ts:1: const room = `drive:${driveId}`;']);
  });

  it('ignores a room shape named only in a comment', () => {
    const offenses = findRoomLiteralOffenses('fixture.ts', "// e.g. `drive:${driveId}`\nconst room = driveRoom(driveId);");
    expect(offenses).toEqual([]);
  });

  it('is clean for source built entirely from the shared builders', () => {
    const offenses = findRoomLiteralOffenses('fixture.ts', 'const room = driveRoom(driveId);');
    expect(offenses).toEqual([]);
  });
});

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
    const offenders: string[] = [];
    for (const entry of readdirSync(SRC_DIR, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const path = join(entry.parentPath, entry.name);
      if (path.includes('__tests__')) continue;

      offenders.push(...findRoomLiteralOffenses(path, readFileSync(path, 'utf8')));
    }

    expect(offenders, `room names must come from @pagespace/lib/realtime/rooms:\n${offenders.join('\n')}`).toEqual([]);
  });
});
