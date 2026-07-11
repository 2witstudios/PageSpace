import { describe, test, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { assert } from '@/stores/__tests__/riteway';

const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }));

import ConfirmRemoveDialog from './ConfirmRemoveDialog';

const clickRemove = () => userEvent.click(screen.getByRole('button', { name: /remove/i }));

describe('ConfirmRemoveDialog', () => {
  beforeEach(() => vi.clearAllMocks());

  test('closes the dialog after a successful removal', async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ConfirmRemoveDialog open onOpenChange={onOpenChange} title="Remove terminal?" description="Remove it?" onConfirm={onConfirm} />,
    );

    await clickRemove();

    await waitFor(() =>
      assert({
        given: 'onConfirm resolves',
        should: 'invoke onConfirm and close the dialog via onOpenChange(false)',
        actual: { confirmed: onConfirm.mock.calls.length, closed: onOpenChange.mock.calls.some((c) => c[0] === false) },
        expected: { confirmed: 1, closed: true },
      }),
    );
  });

  test('keeps the dialog open (and toasts) when removal fails, so the user can retry', async () => {
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn().mockRejectedValue(new Error('boom'));
    render(
      <ConfirmRemoveDialog open onOpenChange={onOpenChange} title="Remove terminal?" description="Remove it?" onConfirm={onConfirm} />,
    );

    await clickRemove();

    // The bug this guards: AlertDialogAction auto-closes on click unless preventDefault
    // is called — which would fire the toast against an already-dismissed dialog.
    await waitFor(() => assert({
      given: 'onConfirm rejects',
      should: 'surface an error toast',
      actual: toastError.mock.calls.length >= 1,
      expected: true,
    }));

    assert({
      given: 'a failed removal',
      should: 'not close the dialog — no onOpenChange(false), so the confirm stays open to retry',
      actual: onOpenChange.mock.calls.some((c) => c[0] === false),
      expected: false,
    });
  });
});
