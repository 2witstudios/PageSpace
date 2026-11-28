// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, unmountAll, typeInto, click } from '@/ui/test-support/dom';
import { useEditingStore } from '@/retained/stores/useEditingStore';
import { DriveAISettings } from './DriveAISettings';

const fetchWithAuth = vi.fn();
const patch = vi.fn();

vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
  patch: (...args: unknown[]) => patch(...args),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  unmountAll();
  fetchWithAuth.mockReset();
  patch.mockReset();
  useEditingStore.getState().endEditing('drive-context');
});

const settle = async (check: () => void): Promise<void> => {
  for (let tries = 0; tries < 150; tries += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    try {
      check();
      return;
    } catch {
      // Not yet.
    }
  }
  check();
};

const textareaOf = (root: ParentNode) => root.querySelector<HTMLTextAreaElement>('textarea[aria-label="Drive context"]');
const buttonNamed = (root: ParentNode, name: string) =>
  [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === name) ?? null;

describe('DriveAISettings', () => {
  test('the counter follows the text, Revert restores it, and a dirty context is registered as being edited', async () => {
    fetchWithAuth.mockResolvedValue(Response.json({ id: 'd1', drivePrompt: 'abc' }));
    const root = mount(<DriveAISettings driveId="d1" />);
    await settle(() => {
      if (textareaOf(root)?.value !== 'abc') throw new Error('not loaded');
    });
    assert({
      given: 'a drive whose context is saved as "abc"',
      should: 'show the counter out of 10,000, Save and Revert disabled, and nothing registered as editing',
      actual: {
        counter: root.querySelector('[data-context-counter]')?.textContent,
        save: buttonNamed(root, 'Save context')?.disabled,
        revert: buttonNamed(root, 'Revert')?.disabled,
        editing: useEditingStore.getState().isAnyEditing(),
      },
      expected: { counter: '3 / 10,000', save: true, revert: true, editing: false },
    });

    typeInto(textareaOf(root) as HTMLTextAreaElement, 'abcd');
    assert({
      given: 'a character typed into the context',
      should: 'update the counter, enable Save and Revert, and register the editor as editing',
      actual: {
        counter: root.querySelector('[data-context-counter]')?.textContent,
        save: buttonNamed(root, 'Save context')?.disabled,
        revert: buttonNamed(root, 'Revert')?.disabled,
        editing: useEditingStore.getState().isAnyEditing(),
      },
      expected: { counter: '4 / 10,000', save: false, revert: false, editing: true },
    });

    click(buttonNamed(root, 'Revert') as HTMLButtonElement);
    assert({
      given: 'Revert clicked',
      should: 'put the saved text back and stop registering the editor',
      actual: { value: textareaOf(root)?.value, editing: useEditingStore.getState().isAnyEditing() },
      expected: { value: 'abc', editing: false },
    });
  });

  test('the three "How it works" bullets are shown', async () => {
    fetchWithAuth.mockResolvedValue(Response.json({ id: 'd1', drivePrompt: null }));
    const root = mount(<DriveAISettings driveId="d1" />);
    await settle(() => {
      if (!root.textContent?.includes('How it works')) throw new Error('not loaded');
    });
    expect(root.querySelectorAll('ul li')).toHaveLength(3);
  });
});
