import { describe, it, expect } from 'vitest';
import { takedownRequestSchema } from '../takedown-request';

const HASH = 'a'.repeat(64);
const parse = (value: unknown) => takedownRequestSchema.safeParse(value);

describe('takedownRequestSchema', () => {
  it('accepts a global takedown with a category and a reason', () => {
    expect(parse({ action: 'global', contentHash: HASH, category: 'csam', reason: 'NCMEC hash match' }).success).toBe(true);
  });

  it.each(['global', 'unpublish_page', 'park_drive', 'avatar'] as const)('requires a reason for %s', (action) => {
    const base = { action, contentHash: HASH, pageId: 'p1', driveId: 'd1', userId: 'u1', category: 'malware' };
    expect(parse({ ...base, reason: '   ' }).success).toBe(false);
    expect(parse(base).success).toBe(false);
    expect(parse({ ...base, reason: 'because' }).success).toBe(true);
  });

  it.each(['unpublish_page', 'park_drive', 'avatar'] as const)('requires a category for %s', (action) => {
    expect(parse({ action, pageId: 'p1', driveId: 'd1', userId: 'u1', reason: 'because' }).success).toBe(false);
  });

  it('refuses a global takedown under the policy category', () => {
    expect(parse({ action: 'global', contentHash: HASH, category: 'policy', reason: 'copyright' }).success).toBe(false);
  });

  it('refuses to skip preservation without a reason, or at all for CSAM', () => {
    const base = { action: 'global', contentHash: HASH, reason: 'r', skipPreservation: true };
    expect(parse({ ...base, category: 'malware' }).success).toBe(false);
    expect(parse({ ...base, category: 'malware', skipPreservationReason: 'known sample' }).success).toBe(true);
    expect(parse({ ...base, category: 'csam', skipPreservationReason: 'x' }).success).toBe(false);
  });

  it('refuses something that is not a sha256 as a content hash', () => {
    expect(parse({ action: 'global', contentHash: 'abc', category: 'csam', reason: 'r' }).success).toBe(false);
  });

  it('refuses IDs that could not be IDs', () => {
    expect(parse({ action: 'resume', caseId: '../x' }).success).toBe(false);
    expect(parse({ action: 'resume', caseId: 'case_1' }).success).toBe(true);
  });

  it('refuses an unknown action', () => {
    expect(parse({ action: 'delete_everything' }).success).toBe(false);
  });
});
