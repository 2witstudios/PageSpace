import { describe, it, expect } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import {
  IdSchema,
  PermissionFlagsSchema,
  GrantInputSchema,
  RevokeInputSchema,
} from '../schemas';

// ---------------------------------------------------------------------------
// IdSchema
// ---------------------------------------------------------------------------
describe('IdSchema', () => {
  it('accepts a valid CUID2 identifier', () => {
    const validId = createId();
    const result = IdSchema.safeParse(validId);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(validId);
    }
  });

  it('rejects a string with hyphens (not valid CUID2 per isCuid)', () => {
    // isCuid rejects strings containing hyphens
    const result = IdSchema.safeParse('not-a-cuid2-with-hyphens');
    expect(result.success).toBe(false);
  });

  it('rejects a UUID (contains hyphens, not CUID2)', () => {
    const result = IdSchema.safeParse('550e8400-e29b-41d4-a716-446655440000');
    expect(result.success).toBe(false);
  });

  it('rejects an empty string (Zod string check)', () => {
    const result = IdSchema.safeParse('');
    // empty string passes Zod string type but isCuid returns false for empty
    expect(result.success).toBe(false);
  });

  it('rejects a number', () => {
    const result = IdSchema.safeParse(123);
    expect(result.success).toBe(false);
  });

  it('rejects null', () => {
    const result = IdSchema.safeParse(null);
    expect(result.success).toBe(false);
  });

  it('provides error message on failure for UUID input', () => {
    const result = IdSchema.safeParse('550e8400-e29b-41d4-a716-446655440000');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Invalid ID format (expected CUID2)');
    }
  });
});

// ---------------------------------------------------------------------------
// PermissionFlagsSchema
// ---------------------------------------------------------------------------
describe('PermissionFlagsSchema', () => {
  it('accepts valid permission flags (all true)', () => {
    const result = PermissionFlagsSchema.safeParse({
      canView: true,
      canEdit: true,
      canShare: true,
      canDelete: true,
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid permission flags (all false)', () => {
    const result = PermissionFlagsSchema.safeParse({
      canView: false,
      canEdit: false,
      canShare: false,
      canDelete: false,
    });
    expect(result.success).toBe(true);
  });

  it('accepts mixed permission flags', () => {
    const result = PermissionFlagsSchema.safeParse({
      canView: true,
      canEdit: false,
      canShare: true,
      canDelete: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing canView', () => {
    const result = PermissionFlagsSchema.safeParse({
      canEdit: true,
      canShare: false,
      canDelete: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing canEdit', () => {
    const result = PermissionFlagsSchema.safeParse({
      canView: true,
      canShare: false,
      canDelete: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing canShare', () => {
    const result = PermissionFlagsSchema.safeParse({
      canView: true,
      canEdit: true,
      canDelete: false,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing canDelete', () => {
    const result = PermissionFlagsSchema.safeParse({
      canView: true,
      canEdit: true,
      canShare: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-boolean canView', () => {
    const result = PermissionFlagsSchema.safeParse({
      canView: 'yes',
      canEdit: false,
      canShare: false,
      canDelete: false,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GrantInputSchema
// ---------------------------------------------------------------------------
describe('GrantInputSchema', () => {
  const validPageId = createId();
  const validTargetUserId = createId();
  const validPermissions = { canView: true, canEdit: true, canShare: false, canDelete: false };

  it('accepts valid grant input', () => {
    const result = GrantInputSchema.safeParse({
      pageId: validPageId,
      targetUserId: validTargetUserId,
      permissions: validPermissions,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid pageId', () => {
    const result = GrantInputSchema.safeParse({
      pageId: 'not-a-cuid2',
      targetUserId: validTargetUserId,
      permissions: validPermissions,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid targetUserId', () => {
    const result = GrantInputSchema.safeParse({
      pageId: validPageId,
      targetUserId: 'not-a-cuid2',
      permissions: validPermissions,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing permissions', () => {
    const result = GrantInputSchema.safeParse({
      pageId: validPageId,
      targetUserId: validTargetUserId,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid permissions object', () => {
    const result = GrantInputSchema.safeParse({
      pageId: validPageId,
      targetUserId: validTargetUserId,
      permissions: { canView: 'yes' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing pageId', () => {
    const result = GrantInputSchema.safeParse({
      targetUserId: validTargetUserId,
      permissions: validPermissions,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing targetUserId', () => {
    const result = GrantInputSchema.safeParse({
      pageId: validPageId,
      permissions: validPermissions,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RevokeInputSchema
// ---------------------------------------------------------------------------
describe('RevokeInputSchema', () => {
  const validPageId = createId();
  const validTargetUserId = createId();

  it('accepts valid revoke input', () => {
    const result = RevokeInputSchema.safeParse({
      pageId: validPageId,
      targetUserId: validTargetUserId,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid pageId', () => {
    const result = RevokeInputSchema.safeParse({
      pageId: 'invalid-id',
      targetUserId: validTargetUserId,
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid targetUserId', () => {
    const result = RevokeInputSchema.safeParse({
      pageId: validPageId,
      targetUserId: 'invalid-id',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing pageId', () => {
    const result = RevokeInputSchema.safeParse({
      targetUserId: validTargetUserId,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing targetUserId', () => {
    const result = RevokeInputSchema.safeParse({
      pageId: validPageId,
    });
    expect(result.success).toBe(false);
  });

  it('rejects null input', () => {
    const result = RevokeInputSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});
