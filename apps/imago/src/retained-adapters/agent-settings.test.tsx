// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { createElement } from 'react';
import { click, mount, unmountAll } from '@/ui/test-support/dom';
import { AgentSettings } from './agent-settings';

const form = vi.hoisted(() => ({
  dirty: false,
  canEdit: true,
  submitForm: vi.fn(),
  discardChanges: vi.fn(),
}));

vi.mock('@/retained/components/ai/page-agents/PageAgentSettingsTab', async () => {
  const { forwardRef, useEffect, useImperativeHandle, createElement: h } = await import('react');
  const Tab = forwardRef<unknown, { category?: string; onDirtyChange?: (dirty: boolean) => void }>((props, ref) => {
    useImperativeHandle(ref, () => ({ submitForm: form.submitForm, discardChanges: form.discardChanges, isSaving: false }));
    const onDirtyChange = props.onDirtyChange;
    useEffect(() => {
      onDirtyChange?.(form.dirty);
    }, [onDirtyChange]);
    return h('div', { 'data-testid': 'settings-tab', 'data-category': props.category });
  });
  return { default: Tab };
});

vi.mock('@/retained/hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: { canEdit: form.canEdit } }),
}));

vi.mock('@/retained/lib/ai/shared/hooks/useAgentConfig', () => ({
  useAgentConfig: () => ({ config: { systemPrompt: '', enabledTools: [] }, setConfig: () => undefined, revalidate: () => undefined }),
}));

vi.mock('@/retained/lib/ai/shared/hooks/useProviderSettings', () => ({
  useProviderSettings: () => ({
    selectedProvider: 'anthropic',
    selectedModel: 'claude',
    setSelectedProvider: () => undefined,
    setSelectedModel: () => undefined,
    isProviderConfigured: () => true,
  }),
}));

beforeEach(() => {
  form.dirty = false;
  form.canEdit = true;
  form.submitForm.mockClear();
  form.discardChanges.mockClear();
});

afterEach(unmountAll);

const buttonNamed = (container: HTMLElement, label: string): HTMLButtonElement | undefined =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === label);

describe('AgentSettings', () => {
  test('shows no unsaved bar while the form is clean', () => {
    const container = mount(createElement(AgentSettings, { pageId: 'a1', driveId: 'd1', category: 'behavior', categoryTitle: 'Behavior' }));
    assert({
      given: 'a clean Behavior form',
      should: 'not show the sticky unsaved bar',
      actual: container.querySelector('[aria-label="Unsaved changes"]'),
      expected: null,
    });
  });

  test('shows a sticky bar naming the category when the form has unsaved edits', () => {
    form.dirty = true;
    const container = mount(createElement(AgentSettings, { pageId: 'a1', driveId: 'd1', category: 'tools', categoryTitle: 'Tools' }));
    assert({
      given: 'unsaved edits in the Tools category',
      should: 'show "Unsaved changes to Tools" with Discard and Save',
      actual: {
        text: container.querySelector('[aria-label="Unsaved changes"]')?.textContent,
        buttons: ['Discard', 'Save'].map((label) => buttonNamed(container, label) !== undefined),
      },
      expected: { text: 'Unsaved changes to ToolsDiscardSave', buttons: [true, true] },
    });
  });

  test('Discard resets the form and Save submits it', () => {
    form.dirty = true;
    const container = mount(createElement(AgentSettings, { pageId: 'a1', driveId: 'd1', category: 'behavior', categoryTitle: 'Behavior' }));
    const discard = buttonNamed(container, 'Discard');
    if (discard) click(discard);
    const save = buttonNamed(container, 'Save');
    if (save) click(save);
    assert({
      given: 'the Discard and Save buttons in the unsaved bar',
      should: 'discard the edits through the form and submit the form on Save',
      actual: { discarded: form.discardChanges.mock.calls.length, saved: form.submitForm.mock.calls.length },
      expected: { discarded: 1, saved: 1 },
    });
  });

  test('passes the chosen category to the form', () => {
    const container = mount(createElement(AgentSettings, { pageId: 'a1', driveId: 'd1', category: 'access', categoryTitle: 'Access' }));
    assert({
      given: 'the Access category chosen in the sub-nav',
      should: 'render the form for Access',
      actual: container.querySelector('[data-testid="settings-tab"]')?.getAttribute('data-category'),
      expected: 'access',
    });
  });

  test('without edit permission says so and shows no bar', () => {
    form.canEdit = false;
    form.dirty = true;
    const container = mount(createElement(AgentSettings, { pageId: 'a1', driveId: 'd1', category: 'behavior', categoryTitle: 'Behavior' }));
    assert({
      given: 'a viewer without edit permission',
      should: 'explain that edit permission is required and offer no form or bar',
      actual: {
        message: container.textContent?.includes('Edit permission is required') ?? false,
        form: container.querySelector('[data-testid="settings-tab"]'),
        bar: container.querySelector('[aria-label="Unsaved changes"]'),
      },
      expected: { message: true, form: null, bar: null },
    });
  });
});
