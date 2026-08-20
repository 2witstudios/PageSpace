import { describe, expect, it } from 'vitest';
import { decideBlobReclaim } from '../page-content-reclaim';

const DAY = 24 * 60 * 60 * 1000;

describe('decideBlobReclaim', () => {
  it('given the last reference dropped and an old blob, deletes', () => {
    expect(
      decideBlobReclaim({ remainingReferences: 0, blobAgeMs: 2 * DAY, minAgeMs: DAY })
    ).toEqual({ action: 'delete' });
  });

  it('given another page still references the blob, retains it', () => {
    expect(
      decideBlobReclaim({ remainingReferences: 1, blobAgeMs: 30 * DAY, minAgeMs: DAY })
    ).toEqual({ action: 'retain', reason: 'still-referenced' });
  });

  it('given references from a different tenant, retains it — the store is not tenant-scoped', () => {
    expect(
      decideBlobReclaim({ remainingReferences: 9, blobAgeMs: 365 * DAY, minAgeMs: DAY }).action
    ).toBe('retain');
  });

  it('given a blob younger than the floor, retains it even with zero references', () => {
    // A concurrent writePageContent can be between its HEAD hit and its row
    // insert right now; the blob is not provably unreferenced.
    expect(
      decideBlobReclaim({ remainingReferences: 0, blobAgeMs: 1000, minAgeMs: DAY })
    ).toEqual({ action: 'retain', reason: 'too-young' });
  });

  it('given an age exactly at the floor, deletes', () => {
    expect(
      decideBlobReclaim({ remainingReferences: 0, blobAgeMs: DAY, minAgeMs: DAY }).action
    ).toBe('delete');
  });

  it('given an undateable blob, fails closed', () => {
    expect(
      decideBlobReclaim({ remainingReferences: 0, blobAgeMs: null, minAgeMs: DAY })
    ).toEqual({ action: 'retain', reason: 'age-unknown' });
  });

  it('checks references before age — a referenced blob is retained whatever its age', () => {
    expect(
      decideBlobReclaim({ remainingReferences: 3, blobAgeMs: null, minAgeMs: DAY })
    ).toEqual({ action: 'retain', reason: 'still-referenced' });
  });
});
