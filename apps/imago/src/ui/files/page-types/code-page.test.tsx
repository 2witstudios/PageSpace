// @vitest-environment jsdom
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { act } from 'react';
import { mount, unmountAll } from '../../test-support/dom';
import { treeRow } from '../file-model/fixtures';
import { useDocumentManagerStore } from '@/retained/stores/useDocumentManagerStore';
import type { TreePage } from '@/retained/hooks/usePageTree';

// The retained editor is a dynamic Monaco import; the strip is what these tests cover.
vi.mock('next/dynamic', () => ({ default: () => () => null }));

const { CodePage } = await import('./code-page');

const page = (title: string): TreePage => treeRow('p1', 'CODE', [], { title }) as unknown as TreePage;

const setSaving = (saving: boolean): void => {
  act(() => {
    useDocumentManagerStore.setState({ savingDocuments: new Set(saving ? ['p1'] : []) });
  });
};

beforeEach(() => {
  useDocumentManagerStore.setState({ documents: new Map(), savingDocuments: new Set() });
});

afterEach(unmountAll);

describe('CodePage Page tools strip', () => {
  test('renders a labelled Page tools toolbar', () => {
    const container = mount(<CodePage page={page('pricing.py')} driveId="d1" pageId="p1" />);
    const toolbar = container.querySelector('[role="toolbar"]');
    assert({
      given: 'a code page',
      should: 'render the strip as a toolbar named "Page tools"',
      actual: toolbar?.getAttribute('aria-label'),
      expected: 'Page tools',
    });
  });

  test('shows a visible Language label bound to the select', () => {
    const container = mount(<CodePage page={page('pricing.py')} driveId="d1" pageId="p1" />);
    const label = Array.from(container.querySelectorAll('label')).find((el) => el.textContent === 'Language');
    const select = label?.control ?? null;
    assert({
      given: 'a code page',
      should: 'label the language select with visible "Language" text',
      actual: select?.getAttribute('role'),
      expected: 'combobox',
    });
  });

  test('detects the language from the title on load', () => {
    const container = mount(<CodePage page={page('pricing.py')} driveId="d1" pageId="p1" />);
    const trigger = container.querySelector('[role="combobox"]');
    assert({
      given: 'a page titled pricing.py',
      should: 'restore the detected Python language on load',
      actual: trigger?.textContent,
      expected: 'Python',
    });
  });

  test('shows Saved when no save is in flight', () => {
    const container = mount(<CodePage page={page('pricing.py')} driveId="d1" pageId="p1" />);
    assert({
      given: 'a code page with nothing pending',
      should: 'show the Saved status at the end of the strip',
      actual: container.querySelector('[role="toolbar"]')?.textContent?.includes('Saved'),
      expected: true,
    });
  });

  test('shows Saving while a save is in flight, then Saved', () => {
    const container = mount(<CodePage page={page('pricing.py')} driveId="d1" pageId="p1" />);
    setSaving(true);
    const during = container.querySelector('[role="toolbar"]')?.textContent ?? '';
    setSaving(false);
    const after = container.querySelector('[role="toolbar"]')?.textContent ?? '';
    assert({
      given: 'an edit that is being saved',
      should: 'show Saving in the strip',
      actual: during.includes('Saving'),
      expected: true,
    });
    assert({
      given: 'the save has finished',
      should: 'show Saved in the strip',
      actual: after.includes('Saved'),
      expected: true,
    });
  });
});
