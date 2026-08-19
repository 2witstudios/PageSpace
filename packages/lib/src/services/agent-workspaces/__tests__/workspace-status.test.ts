import { describe, it, expect } from 'vitest';
import { deriveSandboxStatus } from '../workspace-status';

const NOW = new Date('2026-07-28T12:00:00.000Z');
const UNPROVISIONED = { sandboxId: null, spriteTornDownAt: null, endedAt: null };

describe('deriveSandboxStatus', () => {
  it('given a session that never acquired a Sprite, should report none', () => {
    expect(deriveSandboxStatus(UNPROVISIONED, null)).toBe('none');
  });

  it('given a session with a linked Sprite, should report running', () => {
    expect(deriveSandboxStatus({ ...UNPROVISIONED, sandboxId: 'pgs-ses-abc' }, null)).toBe('running');
  });

  it('given a HIBERNATING Sprite (still linked), should report running — waking is invisible, not a status', () => {
    // There is no hibernation column by design: an idle Sprite costs storage,
    // not compute, and wakes on demand. Anything that reads a linked row as
    // anything but running would show users a state they cannot act on.
    expect(deriveSandboxStatus({ ...UNPROVISIONED, sandboxId: 'pgs-ses-idle' }, null)).toBe('running');
  });

  it('given a CONFIRMED teardown, should report ended', () => {
    expect(deriveSandboxStatus({ sandboxId: 'pgs-ses-abc', spriteTornDownAt: NOW, endedAt: NOW }, null)).toBe('ended');
  });

  it('given endedAt stamped but the kill not yet confirmed, should still report ended', () => {
    // The two stamps land at different moments; a crash between them must not
    // make an ended session read as running.
    expect(deriveSandboxStatus({ sandboxId: 'pgs-ses-abc', spriteTornDownAt: null, endedAt: NOW }, null)).toBe('ended');
  });

  it('given a confirmed kill without an endedAt (a reclaimed orphan), should report ended', () => {
    expect(deriveSandboxStatus({ sandboxId: 'pgs-ses-abc', spriteTornDownAt: NOW, endedAt: null }, null)).toBe('ended');
  });

  it('given an ended session that still carries its old Sprite pointer, should report ended NOT running', () => {
    // The pointer is retained on purpose (a reclaim needs it), so the ended
    // check must come first or a destroyed VM reads as live.
    const row = { sandboxId: 'pgs-ses-dead', spriteTornDownAt: NOW, endedAt: NOW };
    expect(deriveSandboxStatus(row, null)).not.toBe('running');
    expect(deriveSandboxStatus(row, null)).toBe('ended');
  });

  it('given a session ended before it ever provisioned, should report ended', () => {
    expect(deriveSandboxStatus({ sandboxId: null, spriteTornDownAt: null, endedAt: NOW }, null)).toBe('ended');
  });

  it('should never derive starting from a row — provisioning is in-flight state, not persisted state', () => {
    const rows = [
      UNPROVISIONED,
      { ...UNPROVISIONED, sandboxId: 'pgs-ses-abc' },
      { sandboxId: 'pgs-ses-abc', spriteTornDownAt: NOW, endedAt: NOW },
    ];
    for (const row of rows) expect(deriveSandboxStatus(row, null)).not.toBe('starting');
  });
});
