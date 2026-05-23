import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('bootstrapConsumerGuard', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('given a messageId not yet claimed, claimBootstrapConsumer should return true', async () => {
    const { claimBootstrapConsumer } = await import('../bootstrapConsumerGuard');
    expect(claimBootstrapConsumer('msg-1')).toBe(true);
  });

  it('given a messageId already claimed, second call should return false', async () => {
    const { claimBootstrapConsumer } = await import('../bootstrapConsumerGuard');
    claimBootstrapConsumer('msg-1');
    expect(claimBootstrapConsumer('msg-1')).toBe(false);
  });

  it('given two different messageIds, each should claim independently', async () => {
    const { claimBootstrapConsumer } = await import('../bootstrapConsumerGuard');
    expect(claimBootstrapConsumer('msg-A')).toBe(true);
    expect(claimBootstrapConsumer('msg-B')).toBe(true);
  });

  it('given a released messageId, it can be claimed again', async () => {
    const { claimBootstrapConsumer, releaseBootstrapConsumer } = await import('../bootstrapConsumerGuard');
    claimBootstrapConsumer('msg-1');
    releaseBootstrapConsumer('msg-1');
    expect(claimBootstrapConsumer('msg-1')).toBe(true);
  });

  it('given unmount mid-stream, release should allow a fresh surface to take over', async () => {
    const { claimBootstrapConsumer, releaseBootstrapConsumer } = await import('../bootstrapConsumerGuard');

    // Surface A claims
    expect(claimBootstrapConsumer('msg-1')).toBe(true);

    // Surface A unmounts — releases the claim
    releaseBootstrapConsumer('msg-1');

    // Surface B (remounted) can now claim
    expect(claimBootstrapConsumer('msg-1')).toBe(true);
  });
});
