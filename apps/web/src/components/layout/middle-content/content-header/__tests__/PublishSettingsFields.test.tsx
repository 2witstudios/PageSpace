import { describe, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { assert } from '@/stores/__tests__/riteway';

// ============================================================================
// Regression test for a Codex-flagged bug: `disabled` was applied to every
// field EXCEPT the uploaded-image picker, whose prop wasn't forwarded to
// `PagePickerPopover`. A disabled form (an unpublished page, or a view-only
// collaborator) still let the picker open and select an image — which then
// got trapped behind a disabled "Remove" button until the form became
// editable again.
// ============================================================================

vi.mock('@/components/common/PagePickerPopover', () => ({
  PagePickerPopover: vi.fn(() => <div data-testid="page-picker-popover" />),
}));

import { PagePickerPopover } from '@/components/common/PagePickerPopover';
import { PublishSettingsFields, EMPTY_SETTINGS } from '../PublishSettingsFields';

describe('PublishSettingsFields — uploaded-image picker respects disabled', () => {
  it('given disabled=true and no picked image, forwards disabled to PagePickerPopover', () => {
    render(
      <PublishSettingsFields
        value={EMPTY_SETTINGS}
        onChange={vi.fn()}
        pickedImageId={null}
        onPickedImageIdChange={vi.fn()}
        driveId="drive_1"
        disabled
      />
    );

    const call = vi.mocked(PagePickerPopover).mock.calls[0][0];
    assert({
      given: 'a disabled form (unpublished page, or a view-only collaborator) with no image picked yet',
      should: 'forward disabled=true to the uploaded-image picker, not leave it interactive',
      actual: call.disabled,
      expected: true,
    });
  });
});
