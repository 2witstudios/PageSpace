// @vitest-environment jsdom
import type { Editor } from '@tiptap/react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, press, unmountAll } from '../../test-support/dom';
import { useDocumentManagerStore } from '@/retained/stores/useDocumentManagerStore';
import { useDocumentStore } from '@/retained/stores/useDocumentStore';
import { useFindStore } from '@/retained/stores/useFindStore';
import { getEffectiveBinding } from '@/retained/stores/useHotkeyStore';
import { DocumentTitle, FindStrip, FormattingStrip, editedAtOf, editedLabel, useFindShortcut } from './document-page';

vi.mock('@/retained/hooks/useMobile', () => ({ useMobile: () => false }));
vi.mock('@/retained/hooks/useDisplayPreferences', () => ({
  useDisplayPreferences: () => ({ preferences: { showCodeToggle: display.showCodeToggle, showTokenCounts: false, defaultMarkdownMode: false } }),
}));
vi.mock('@/retained/components/layout/middle-content/content-header/EditableTitle', () => ({
  EditableTitle: ({ variant }: { readonly variant?: string }) => <h1 data-variant={variant}>Q4 Launch Plan</h1>,
}));
const display = vi.hoisted(() => ({ showCodeToggle: false }));
const pageState = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock('../page-object/page-object', () => ({ usePage: () => ({ data: pageState.data }) }));

const NOW = new Date('2026-10-12T12:00:00.000Z');
const MINUTES_AGO = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

/**
 * A stand-in for the TipTap editor: only what the Formatting strip reads. `active` lists the marks
 * and blocks the selection is in.
 */
const fakeEditor = (active: readonly string[]): Editor =>
  ({
    isDestroyed: false,
    on: () => undefined,
    off: () => undefined,
    isActive: (name: string) => active.includes(name),
    getAttributes: () => ({}),
    chain: () => ({ focus: () => ({}) }),
    view: { dom: document.createElement('div') },
    state: { selection: { from: 0, to: 0 } },
  }) as unknown as Editor;

const PAGE_ID = 'plan';

beforeEach(() => {
  useDocumentStore.setState({ activeView: 'rich' });
  useDocumentManagerStore.setState({ savingDocuments: new Set() });
  pageState.data = undefined;
  display.showCodeToggle = false;
});

afterEach(unmountAll);

describe('editedLabel (IMC-3.2)', () => {
  test('the meta line names the relative time of the last edit', () => {
    assert({
      given: 'a page last updated two minutes before now',
      should: 'read "Edited 2 minutes ago"',
      actual: editedLabel(new Date(MINUTES_AGO(2)), NOW),
      expected: 'Edited 2 minutes ago',
    });
  });

  test('editedAtOf reads the page updatedAt and ignores a missing one', () => {
    assert({
      given: 'a page payload with an updatedAt string, and one without',
      should: 'return the date for the first and null for the second',
      actual: [editedAtOf({ updatedAt: MINUTES_AGO(2) })?.toISOString(), editedAtOf({ title: 'Plan' })],
      expected: [MINUTES_AGO(2), null],
    });
  });
});

describe('FormattingStrip (IMC-3.1)', () => {
  test('the default rich strip hides editor modes and keeps formatting tools and Saved', () => {
    const root = mount(<FormattingStrip pageId={PAGE_ID} state={{ editor: fakeEditor([]), contentMode: 'html', formatting: true }} />);
    const strip = root.querySelector('[role="toolbar"]');
    const labelled = (label: string) => root.querySelector(`[aria-label="${label}"]`);
    assert({
      given: 'a rich, editable document',
      should: 'render the Formatting toolbar without the Editor mode group, with every labelled tool and the Saved status',
      actual: [
        strip?.getAttribute('aria-label'),
        root.querySelector('[role="group"][aria-label="Editor mode"]')?.textContent,
        ['Block type', 'Bold', 'Italic', 'Strikethrough', 'Inline code', 'Bulleted list', 'Numbered list', 'Quote', 'Link', 'Insert table']
          .every((label) => labelled(label) !== null),
        strip?.textContent?.includes('Saved'),
      ],
      expected: ['Formatting', undefined, true, true],
    });
  });

  test('disabling the code toggle returns an open code editor to Rich mode', () => {
    useDocumentStore.setState({ activeView: 'code' });
    const root = mount(<FormattingStrip pageId={PAGE_ID} state={{ editor: null, contentMode: 'html', formatting: false }} />);
    assert({
      given: 'Code mode active with the code toggle disabled',
      should: 'return to Rich mode and hide editor mode controls',
      actual: [useDocumentStore.getState().activeView, root.querySelector('[aria-label="Editor mode"]')],
      expected: ['rich', null],
    });
  });

  test('an active mark is pressed', () => {
    const root = mount(<FormattingStrip pageId={PAGE_ID} state={{ editor: fakeEditor(['bold']), contentMode: 'html', formatting: true }} />);
    const bold = root.querySelector('[aria-label="Bold"]');
    const italic = root.querySelector('[aria-label="Italic"]');
    assert({
      given: 'a selection inside bold text',
      should: 'press Bold and leave Italic unpressed',
      actual: [bold?.getAttribute('aria-pressed'), italic?.getAttribute('aria-pressed')],
      expected: ['true', 'false'],
    });
  });

  test('Code mode: the group shows Code pressed and no formatting tools', () => {
    display.showCodeToggle = true;
    useDocumentStore.setState({ activeView: 'code' });
    const root = mount(<FormattingStrip pageId={PAGE_ID} state={{ editor: fakeEditor([]), contentMode: 'markdown', formatting: false }} />);
    const markdown = [...root.querySelectorAll('[role="group"][aria-label="Editor mode"] button')].find((b) => b.textContent === 'Code');
    assert({
      given: 'the document in Markdown mode',
      should: 'press the Code toggle and drop the rich formatting tools',
      actual: [markdown?.getAttribute('aria-pressed'), root.querySelector('[aria-label="Bold"]')],
      expected: ['true', null],
    });
  });

  test('Saving… shows while the document saves, then Saved', () => {
    useDocumentManagerStore.setState({ savingDocuments: new Set([PAGE_ID]) });
    const root = mount(<FormattingStrip pageId={PAGE_ID} state={{ editor: null, contentMode: 'html', formatting: false }} />);
    const savingText = root.querySelector('[role="toolbar"]')?.textContent ?? '';
    assert({
      given: 'a document mid-save',
      should: 'show Saving… at the end of the strip',
      actual: savingText.includes('Saving…'),
      expected: true,
    });
  });
});

describe('DocumentTitle (IMC-3.2)', () => {
  test('the meta line and the in-body title above the prose', () => {
    pageState.data = { updatedAt: MINUTES_AGO(2) };
    const root = mount(<DocumentTitle pageId={PAGE_ID} />);
    const h1 = root.querySelector('h1');
    const meta = root.querySelector('p');
    assert({
      given: 'a document edited two minutes ago',
      should: 'render the muted meta line, then one body-size h1',
      actual: [meta?.textContent?.startsWith('Edited '), h1?.getAttribute('data-variant'), h1?.textContent],
      expected: [true, 'body', 'Q4 Launch Plan'],
    });
  });

  test('no meta line before the page has loaded its updatedAt', () => {
    const root = mount(<DocumentTitle pageId={PAGE_ID} />);
    assert({
      given: 'a page whose updatedAt is not loaded',
      should: 'leave out the meta line and keep the title',
      actual: [root.querySelector('p'), root.querySelector('h1')?.textContent],
      expected: [null, 'Q4 Launch Plan'],
    });
  });
});

describe('find in page (IMC-9.10)', () => {
  beforeEach(() => {
    useFindStore.getState().reset();
  });

  const ShortcutProbe = () => {
    useFindShortcut();
    return null;
  };

  test('Cmd+F on the document opens the find strip, and a second Cmd+F refocuses it', () => {
    mount(<ShortcutProbe />);
    // The default binding is Cmd+F on a Mac and Ctrl+F elsewhere; match whichever this platform resolves.
    const modifier = getEffectiveBinding('editing.find').startsWith('Ctrl+') ? { ctrlKey: true } : { metaKey: true };
    const event = new KeyboardEvent('keydown', { key: 'f', ...modifier, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    assert({
      given: 'a document with find closed',
      should: 'open find and cancel the browser find on Cmd+F',
      actual: [useFindStore.getState().isOpen, event.defaultPrevented],
      expected: [true, true],
    });
  });

  test('the find strip is labelled "Find in page" and shows only while find is open', () => {
    const closed = mount(<FindStrip />);
    const whileClosed = closed.querySelector('[role="toolbar"]');
    useFindStore.setState({ isOpen: true, query: 'owner', totalMatches: 2, currentIndex: 0 });
    const open = mount(<FindStrip />);
    assert({
      given: 'find closed, then open with the query "owner" and two matches',
      should: 'render no strip while closed and a labelled toolbar with "1 of 2" when open',
      actual: [
        whileClosed,
        open.querySelector('[role="toolbar"]')?.getAttribute('aria-label'),
        open.textContent?.includes('1 of 2'),
      ],
      expected: [null, 'Find in page', true],
    });
  });

  test('Enter in the find strip advances the match', () => {
    useFindStore.setState({ isOpen: true, query: 'owner', totalMatches: 2, currentIndex: 0 });
    const open = mount(<FindStrip />);
    press(open.querySelector('input') as HTMLInputElement, 'Enter');
    assert({
      given: 'the find strip with two matches',
      should: 'advance to the second match on Enter',
      actual: useFindStore.getState().currentIndex,
      expected: 1,
    });
  });
});

describe('find shortcut edge cases and updatedAt parsing (IMC-9.10)', () => {
  const ShortcutProbe = () => {
    useFindShortcut();
    return null;
  };
  const pressFind = () => {
    const modifier = getEffectiveBinding('editing.find').startsWith('Ctrl+') ? { ctrlKey: true } : { metaKey: true };
    const event = new KeyboardEvent('keydown', { key: 'f', ...modifier, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    return event;
  };

  beforeEach(() => useFindStore.getState().reset());

  test('ignores keys that are not the find binding', () => {
    mount(<ShortcutProbe />);
    const event = new KeyboardEvent('keydown', { key: 'g', bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    assert({ given: 'an unrelated key', should: 'leave find closed', actual: [useFindStore.getState().isOpen, event.defaultPrevented], expected: [false, false] });
  });

  test('leaves the shortcut to Monaco while it has focus', () => {
    mount(<ShortcutProbe />);
    const monaco = document.createElement('div');
    monaco.className = 'monaco-editor';
    const input = document.createElement('input');
    monaco.append(input);
    document.body.append(monaco);
    input.focus();
    const event = pressFind();
    monaco.remove();
    assert({ given: 'focus inside Monaco', should: 'not open find', actual: [useFindStore.getState().isOpen, event.defaultPrevented], expected: [false, false] });
  });

  test('a second press while open focuses and selects the find field', () => {
    mount(<ShortcutProbe />);
    const field = document.createElement('input');
    field.setAttribute('data-find-field', '');
    field.value = 'owner';
    document.body.append(field);
    useFindStore.setState({ isOpen: true });
    pressFind();
    const focused = document.activeElement === field;
    field.remove();
    assert({ given: 'find already open', should: 'focus the find field', actual: focused, expected: true });
  });

  test('a second press while open with no field on screen does nothing harmful', () => {
    mount(<ShortcutProbe />);
    useFindStore.setState({ isOpen: true });
    const event = pressFind();
    assert({ given: 'find open without a field', should: 'still cancel the browser find', actual: event.defaultPrevented, expected: true });
  });

  test('editedAtOf accepts a Date, and rejects other types and invalid dates', () => {
    assert({
      given: 'a Date, a number, and an unparseable string',
      should: 'return the Date, then null, then null',
      actual: [editedAtOf({ updatedAt: NOW })?.toISOString(), editedAtOf({ updatedAt: 5 }), editedAtOf({ updatedAt: 'not a date' }), editedAtOf('x')],
      expected: [NOW.toISOString(), null, null, null],
    });
  });
});
