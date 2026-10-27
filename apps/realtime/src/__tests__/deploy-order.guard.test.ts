/**
 * REALTIME DEPLOYS BEFORE WEB — pinned against the workflow that does it.
 *
 * This service owns the room grammar and the socket event handlers
 * (`join_conversation`, `join_session`) that `apps/web`'s client code emits
 * into. The dependency is therefore strictly one-way: NEW WEB NEEDS NEW
 * REALTIME, never the reverse.
 *
 * Socket.IO makes the failure of the wrong order silent rather than loud. An
 * old realtime that has no listener registered for `join_conversation` does
 * not error, does not disconnect, and does not tell the client anything — it
 * simply drops the event. So a new web client emitting a join it believes
 * succeeded never enters the room, and every rev-carrying
 * `conversation:*` event for that conversation fans out to a room the client
 * is not in. Live delivery degrades to nothing, invisibly, for the whole
 * deploy window, and the client has no signal to retry on.
 *
 * Deploying realtime FIRST inverts that into the benign case: an old web
 * client simply never emits the new joins, and the new handlers sit idle
 * until it reloads.
 *
 * Comments have already asserted this ordering as fact while the workflow did
 * the opposite (see `src/terminal/shell-activity.ts`, which froze a wire field
 * name on the strength of it). This test is the thing that makes the claim
 * true instead of merely written down — cf. `docs/2.0-architecture/agent-sessions.md` §5.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// vitest runs with cwd = apps/realtime.
const WORKFLOW = resolve(process.cwd(), '../../.github/workflows/docker-images.yml');
const workflow = readFileSync(WORKFLOW, 'utf8');

/** The line index of a `- name: <step>` deploy step, or -1. */
function stepIndex(name: string): number {
  return workflow.split('\n').findIndex((line) => line.trim() === `- name: ${name}`);
}

describe('Fly deploy order (docker-images.yml)', () => {
  it('found the deploy steps (guard is actually scanning something)', () => {
    expect(stepIndex('Deploy web')).toBeGreaterThan(-1);
    expect(stepIndex('Deploy realtime')).toBeGreaterThan(-1);
  });

  it('deploys realtime BEFORE web', () => {
    // Web's client code emits socket events this service must already be
    // listening for. Reversing these two steps silently breaks live delivery
    // for the duration of the deploy — see this file's header.
    expect(stepIndex('Deploy realtime')).toBeLessThan(stepIndex('Deploy web'));
  });
});
