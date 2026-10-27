import { describe, expect, it } from 'vitest';
import { decideBlobReclaim } from '../page-content-reclaim';

const DAY = 24 * 60 * 60 * 1000;

/**
 * This function answers the SECOND of reclaim's two questions — is the object
 * old enough. The first — is anything still referencing it — is settled in
 * `deletePageContent`, which short-circuits before it ever asks storage about
 * the blob, and is covered in `page-content-delete.test.ts` ("does not go near
 * storage for a blob it already knows is referenced"). Do not re-add a
 * `hasReferences` input here: two places deciding the same thing is how they
 * come to disagree.
 */
describe('decideBlobReclaim', () => {
  it('given an old blob, deletes', () => {
    expect(decideBlobReclaim({ blobAgeMs: 2 * DAY, minAgeMs: DAY })).toEqual({ action: 'delete' });
  });

  it('given a blob younger than the floor, retains it', () => {
    // A concurrent writePageContent can be between its dedupe hit and its
    // caller's row insert right now; the blob is not provably unreferenced.
    expect(decideBlobReclaim({ blobAgeMs: 1000, minAgeMs: DAY })).toEqual({
      action: 'retain',
      reason: 'too-young',
    });
  });

  it('given an age exactly at the floor, deletes', () => {
    expect(decideBlobReclaim({ blobAgeMs: DAY, minAgeMs: DAY }).action).toBe('delete');
  });

  it('given an undateable blob, fails closed', () => {
    // Not being able to date an object is not evidence that it is old.
    expect(decideBlobReclaim({ blobAgeMs: null, minAgeMs: DAY })).toEqual({
      action: 'retain',
      reason: 'age-unknown',
    });
  });
});
