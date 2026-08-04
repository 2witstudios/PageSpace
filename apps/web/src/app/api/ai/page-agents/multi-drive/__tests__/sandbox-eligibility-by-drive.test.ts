import { describe, it, expect } from 'vitest';
import { computeSandboxEligibilityByDrive } from '../sandbox-eligibility-by-drive';

describe('computeSandboxEligibilityByDrive', () => {
  it('marks a drive eligible when its owner is on a paying tier', () => {
    const result = computeSandboxEligibilityByDrive(
      [{ id: 'drive-1', ownerId: 'owner-1' }],
      [{ id: 'owner-1', subscriptionTier: 'pro' }],
    );
    expect(result.get('drive-1')).toBe(true);
  });

  it('marks a drive ineligible when its owner is free-tier', () => {
    const result = computeSandboxEligibilityByDrive(
      [{ id: 'drive-1', ownerId: 'owner-1' }],
      [{ id: 'owner-1', subscriptionTier: 'free' }],
    );
    expect(result.get('drive-1')).toBe(false);
  });

  it('defaults to free (ineligible) when the owner row is missing entirely', () => {
    const result = computeSandboxEligibilityByDrive([{ id: 'drive-1', ownerId: 'owner-missing' }], []);
    expect(result.get('drive-1')).toBe(false);
  });

  it('coerces an unrecognized/malformed tier string to free (ineligible), never throws', () => {
    const result = computeSandboxEligibilityByDrive(
      [{ id: 'drive-1', ownerId: 'owner-1' }],
      [{ id: 'owner-1', subscriptionTier: 'not-a-real-tier' }],
    );
    expect(result.get('drive-1')).toBe(false);
  });

  it('resolves each drive independently — a free-tier owner does not poison a co-owned Pro drive, or vice versa', () => {
    const result = computeSandboxEligibilityByDrive(
      [
        { id: 'drive-free', ownerId: 'owner-free' },
        { id: 'drive-pro', ownerId: 'owner-pro' },
      ],
      [
        { id: 'owner-free', subscriptionTier: 'free' },
        { id: 'owner-pro', subscriptionTier: 'pro' },
      ],
    );
    expect(result.get('drive-free')).toBe(false);
    expect(result.get('drive-pro')).toBe(true);
  });

  it('dedupes correctly when several drives share the same owner — one owner row covers them all', () => {
    const result = computeSandboxEligibilityByDrive(
      [
        { id: 'drive-a', ownerId: 'owner-1' },
        { id: 'drive-b', ownerId: 'owner-1' },
        { id: 'drive-c', ownerId: 'owner-1' },
      ],
      [{ id: 'owner-1', subscriptionTier: 'business' }],
    );
    expect(result.get('drive-a')).toBe(true);
    expect(result.get('drive-b')).toBe(true);
    expect(result.get('drive-c')).toBe(true);
  });

  it('given no drives at all, returns an empty map', () => {
    const result = computeSandboxEligibilityByDrive([], []);
    expect(result.size).toBe(0);
  });
});
