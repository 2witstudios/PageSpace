import { describe, it, expect, vi, beforeEach } from 'vitest';

// MACHINE_MARKUP_BPS is computed at module-import time from an env var, so
// each test re-imports the module with different env conditions (same
// pattern as auth/__tests__/constants.test.ts).

describe('MACHINE_MARKUP_BPS floor clamp', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.MACHINE_MARKUP_BPS;
    delete process.env.CREDIT_MARKUP_BPS;
  });

  it('defaults to the 15000bps (1.5x) floor when unset', async () => {
    const { MACHINE_MARKUP_BPS, MACHINE_MARKUP_FLOOR_BPS } = await import('../credit-pricing');
    expect(MACHINE_MARKUP_BPS).toBe(15000);
    expect(MACHINE_MARKUP_FLOOR_BPS).toBe(15000);
  });

  it('clamps UP to the floor when the env var is set below it (misconfiguration guard)', async () => {
    // The exact scenario Codex flagged: an env typo or someone mirroring a
    // reduced AI markup must not be able to silently violate the 1.5x floor.
    process.env.MACHINE_MARKUP_BPS = '5000';
    const { MACHINE_MARKUP_BPS } = await import('../credit-pricing');
    expect(MACHINE_MARKUP_BPS).toBe(15000);
  });

  it('clamps a zero env value up to the floor', async () => {
    process.env.MACHINE_MARKUP_BPS = '0';
    const { MACHINE_MARKUP_BPS } = await import('../credit-pricing');
    expect(MACHINE_MARKUP_BPS).toBe(15000);
  });

  it('passes through a deliberately HIGHER markup unclamped (no ceiling)', async () => {
    process.env.MACHINE_MARKUP_BPS = '20000';
    const { MACHINE_MARKUP_BPS } = await import('../credit-pricing');
    expect(MACHINE_MARKUP_BPS).toBe(20000);
  });

  it('is independent of CREDIT_MARKUP_BPS — lowering the shared AI markup does not move the terminal floor', async () => {
    process.env.CREDIT_MARKUP_BPS = '5000';
    const { MACHINE_MARKUP_BPS, MARKUP_BPS } = await import('../credit-pricing');
    expect(MARKUP_BPS).toBe(5000);
    expect(MACHINE_MARKUP_BPS).toBe(15000);
  });
});
