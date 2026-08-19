import { describe, it, expect } from 'vitest';
import { deriveSandboxStatus, resolveLiveSandboxId } from '../workspace-status';

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

/**
 * WHICH sandbox a session's work runs on.
 *
 * The bug this exists to prevent is quiet rather than loud: a caller that reads
 * `row.sandboxId` on an env-bound session gets null, concludes there is no
 * sandbox, and takes its nothing-to-do branch — a shell close that skips
 * `killSession` yet still drops the row (a PTY left running on a SHARED,
 * long-lived VM with nothing pointing at it), or a file browser that reports
 * `not_started` against a running environment.
 */
describe('resolveLiveSandboxId', () => {
  const UNPROVISIONED = { sandboxId: null, spriteTornDownAt: null };

  it('given an ordinary session, should answer its OWN pointer', () => {
    expect(resolveLiveSandboxId({ sandboxId: 'pgs-ses-abc', spriteTornDownAt: null }, null)).toBe('pgs-ses-abc');
    expect(resolveLiveSandboxId(UNPROVISIONED, null)).toBeNull();
  });

  it("given an env-bound session, should answer the ENV's pointer — never the row's permanently-null one", () => {
    // The session's own columns are CHECK-forbidden to hold anything, so this
    // is the ONLY way such a session ever resolves a machine.
    expect(resolveLiveSandboxId(UNPROVISIONED, { sandboxId: 'pgs-env-abc', spriteTornDownAt: null })).toBe(
      'pgs-env-abc',
    );
  });

  it('given an env with no machine yet, should answer none — lazily provisioned is not provisioned', () => {
    expect(resolveLiveSandboxId(UNPROVISIONED, { sandboxId: null, spriteTornDownAt: null })).toBeNull();
  });

  it('given a TORN-DOWN machine, should answer none for either holder — the pointer outlives the VM', () => {
    // Checked on `spriteTornDownAt`, not on the pointer being absent: teardown
    // deliberately LEAVES `sandboxId` in place (a reclaim needs it), so testing
    // the pointer alone would hand callers a dead sandbox to attach to.
    expect(resolveLiveSandboxId({ sandboxId: 'pgs-ses-abc', spriteTornDownAt: NOW }, null)).toBeNull();
    expect(resolveLiveSandboxId(UNPROVISIONED, { sandboxId: 'pgs-env-abc', spriteTornDownAt: NOW })).toBeNull();
  });

  it('should agree with deriveSandboxStatus about whether a machine is there', () => {
    // Two readings of one fact; they must not be able to disagree, or a session
    // renders `running` while its file browser says `not_started`.
    const cases: Array<[{ sandboxId: string | null; spriteTornDownAt: Date | null }, { sandboxId: string | null; spriteTornDownAt: Date | null } | null]> = [
      [{ sandboxId: 'pgs-ses-a', spriteTornDownAt: null }, null],
      [UNPROVISIONED, null],
      [{ sandboxId: 'pgs-ses-a', spriteTornDownAt: NOW }, null],
      [UNPROVISIONED, { sandboxId: 'pgs-env-a', spriteTornDownAt: null }],
      [UNPROVISIONED, { sandboxId: null, spriteTornDownAt: null }],
      [UNPROVISIONED, { sandboxId: 'pgs-env-a', spriteTornDownAt: NOW }],
    ];
    for (const [row, env] of cases) {
      const hasMachine = resolveLiveSandboxId(row, env) !== null;
      expect(deriveSandboxStatus({ ...row, endedAt: null }, env) === 'running').toBe(hasMachine);
    }
  });
});
