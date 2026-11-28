import { describe, it, expect } from 'vitest';
import { applyOpenDriveFloor } from '../open-drive-floor';
import type { PermissionLevel } from '../permissions';

const NONE: PermissionLevel = { canView: false, canEdit: false, canShare: false, canDelete: false };
const VIEW: PermissionLevel = { canView: true, canEdit: false, canShare: false, canDelete: false };
const EDIT: PermissionLevel = { canView: true, canEdit: true, canShare: false, canDelete: false };
const FULL: PermissionLevel = { canView: true, canEdit: true, canShare: true, canDelete: true };
const PAGE = { isPrivate: false };
const PRIVATE_PAGE = { isPrivate: true };

describe('applyOpenDriveFloor', () => {
  it('POL-6 (partial) a view floor raises no access, and a view-denying answer, to view on a non-private page', () => {
    expect(applyOpenDriveFloor(null, 'view', PAGE)).toEqual(VIEW);
    expect(applyOpenDriveFloor(NONE, 'view', PAGE)).toEqual(VIEW);
  });

  it('POL-6 (partial) an edit floor raises no access, view and a view-denying answer to view and edit on a non-private page', () => {
    expect(applyOpenDriveFloor(null, 'edit', PAGE)).toEqual(EDIT);
    expect(applyOpenDriveFloor(NONE, 'edit', PAGE)).toEqual(EDIT);
    expect(applyOpenDriveFloor(VIEW, 'edit', PAGE)).toEqual(EDIT);
  });

  it('POL-6 (partial) never lowers: every flag the answer already grants survives, under either floor', () => {
    for (const floor of ['view', 'edit'] as const) {
      expect(applyOpenDriveFloor(FULL, floor, PAGE)).toEqual(FULL);
      expect(applyOpenDriveFloor(FULL, floor, PRIVATE_PAGE)).toEqual(FULL);
      expect(applyOpenDriveFloor({ canView: true, canEdit: true, canShare: true, canDelete: false }, floor, PAGE))
        .toEqual({ canView: true, canEdit: true, canShare: true, canDelete: false });
      // A legacy grant that edits without viewing keeps its edit; the floor only adds view.
      expect(applyOpenDriveFloor({ canView: false, canEdit: true, canShare: false, canDelete: false }, floor, PAGE)).toEqual(EDIT);
    }
    expect(applyOpenDriveFloor(EDIT, 'view', PAGE)).toEqual(EDIT);
  });

  it('POL-6 (partial) the floor never grants share or delete', () => {
    for (const floor of ['view', 'edit'] as const) {
      const floored = applyOpenDriveFloor(null, floor, PAGE);
      expect(floored?.canShare).toBe(false);
      expect(floored?.canDelete).toBe(false);
    }
  });

  it('POL-6 (partial) the floor never opens a private page: the answer passes through unchanged', () => {
    for (const floor of ['view', 'edit'] as const) {
      expect(applyOpenDriveFloor(null, floor, PRIVATE_PAGE)).toBeNull();
      expect(applyOpenDriveFloor(NONE, floor, PRIVATE_PAGE)).toEqual(NONE);
      expect(applyOpenDriveFloor(VIEW, floor, PRIVATE_PAGE)).toEqual(VIEW);
    }
  });

  it('POL-6 (partial) with no floor (not an implicit Open-drive membership) the answer passes through unchanged', () => {
    expect(applyOpenDriveFloor(null, null, PAGE)).toBeNull();
    expect(applyOpenDriveFloor(NONE, null, PAGE)).toEqual(NONE);
    expect(applyOpenDriveFloor(VIEW, null, PAGE)).toEqual(VIEW);
  });

  it('returns a new object and leaves its input untouched', () => {
    const input = { ...VIEW };
    const floored = applyOpenDriveFloor(input, 'edit', PAGE);
    expect(floored).not.toBe(input);
    expect(input).toEqual(VIEW);
  });
});
