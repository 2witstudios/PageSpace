/**
 * `localFactsFor` — the sibling row projected into the local DTO's facts
 * (GA wave 3 additions: `ownerId`, `capabilities`, `paused`). Pure.
 */
import { describe, it, expect } from 'vitest';
import { localFactsFor } from '../drive-envs';
import { makeEnvRecord, makeLocalRecord, NOW } from './fakes';

const row = makeEnvRecord({ substrate: 'local' });
const caps = { shell: true, pty: false, fs: true, checkpoint: false };

describe('localFactsFor — the GA wave 3 facts', () => {
  it('projects the owner, the advertised capabilities (a fresh copy), and paused = pausedAt IS NOT NULL', () => {
    const facts = localFactsFor(row, makeLocalRecord({ enrolledAt: NOW, capabilities: caps, pausedAt: new Date(NOW.getTime() + 1) }), 'connected', NOW.getTime());
    expect(facts).toMatchObject({ ownerId: 'user-1', capabilities: caps, paused: true, enrolled: true, status: 'connected' });
    expect(facts.capabilities).not.toBe(caps);
  });

  it('a running row reads paused: false; a never-connected machine has null capabilities', () => {
    const facts = localFactsFor(row, makeLocalRecord({ enrolledAt: NOW, capabilities: null, pausedAt: null }), null, NOW.getTime());
    expect(facts).toMatchObject({ paused: false, capabilities: null });
  });

  it('a DEAD local env (no sibling) has no owner, no capabilities, and is not paused', () => {
    expect(localFactsFor(row, undefined, null, NOW.getTime())).toMatchObject({ ownerId: null, capabilities: null, paused: false, status: 'disconnected' });
  });
});
