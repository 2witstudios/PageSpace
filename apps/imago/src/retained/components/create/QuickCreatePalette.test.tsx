// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, test, vi } from 'vitest';
import { assert } from 'riteway/vitest';
import { mount, typeInto, unmountAll } from '@/ui/test-support/dom';
import { useUIStore } from '@/retained/stores/useUIStore';
import QuickCreatePalette from './QuickCreatePalette';

const spies = vi.hoisted(() => ({
  post: vi.fn(),
  uploadFileToS3: vi.fn(),
  navigateToPage: vi.fn(),
}));

vi.mock('@/retained-adapters/navigation', () => ({
  useParams: () => ({ driveId: 'd1' }),
  usePathname: () => '/dashboard/d1/files',
}));
vi.mock('swr', () => ({
  default: () => ({ data: [] }),
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/retained/lib/auth/auth-fetch', () => ({
  post: spies.post,
  fetchWithAuth: vi.fn(),
}));
vi.mock('@/retained/lib/upload/orchestrator', () => ({ uploadFileToS3: spies.uploadFileToS3 }));
vi.mock('@/retained/hooks/usePageNavigation', () => ({ usePageNavigation: () => ({ navigateToPage: spies.navigateToPage }) }));
vi.mock('@/retained/hooks/useBreadcrumbs', () => ({ useBreadcrumbs: () => ({ breadcrumbs: [] }) }));
vi.mock('@/retained/hooks/useDisplayPreferences', () => ({
  useDisplayPreferences: () => ({ preferences: { defaultMarkdownMode: false } }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

beforeEach(() => {
  // Radix popper measures its anchor and content; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  // cmdk scrolls the selected row into view; jsdom does not implement it.
  Element.prototype.scrollIntoView ??= () => {};
  spies.post.mockReset();
  spies.uploadFileToS3.mockReset();
  spies.navigateToPage.mockReset();
  useUIStore.setState({ quickCreateOpen: false, quickCreateParentOverride: undefined, quickCreateAnchor: null });
});

afterEach(() => {
  unmountAll();
  document.body.innerHTML = '';
});

/** Runs a click inside act and waits for the async handler it starts. */
const clickAsync = async (element: Element | null | undefined) => {
  await act(async () => {
    (element as HTMLElement).click();
  });
};

const panel = () => document.querySelector<HTMLElement>('[role="dialog"]');
const optionByName = (name: string) =>
  Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent?.startsWith(name));
const buttonByText = (text: string) =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent?.trim() === text);

describe('QuickCreatePalette pick step (IMC-9.9)', () => {
  test('the "+" opens the palette anchored under it, with the search and the nine page types', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    mount(<QuickCreatePalette />);
    act(() => useUIStore.getState().openQuickCreate(null, anchor));
    assert({
      given: 'the Files pane "+" opening the palette',
      should: 'anchor the palette under the button with "Search page types…" and the nine types',
      actual: [
        panel()?.getAttribute('aria-label'),
        panel()?.getAttribute('data-side'),
        document.querySelector('input[placeholder="Search page types…"]') !== null,
        document.querySelectorAll('[role="option"]').length,
      ],
      expected: ['Create new page', 'bottom', true, 9],
    });
  });

  test('opened without an anchor, the same palette is the centred dialog', () => {
    mount(<QuickCreatePalette />);
    act(() => useUIStore.getState().openQuickCreate(null));
    assert({
      given: 'a palette opened from elsewhere in the app (no anchor)',
      should: 'show the centred dialog without a popover side',
      actual: [panel()?.getAttribute('data-side') ?? null, document.querySelectorAll('[role="option"]').length],
      expected: [null, 9],
    });
  });
});

describe('QuickCreatePalette name step (IMC-9.9)', () => {
  test('choosing a page type steps to "Name your page" with the default name and Back and Create', () => {
    mount(<QuickCreatePalette />);
    act(() => useUIStore.getState().openQuickCreate(null));
    act(() => optionByName('Document')?.click());
    const input = document.querySelector<HTMLInputElement>('#quick-create-name');
    assert({
      given: 'the Document type chosen',
      should: 'step to "Name your page" with the default name, a Back button and a Create button',
      actual: [
        document.body.textContent?.includes('Name your page'),
        input?.value,
        Boolean(buttonByText('Back')),
        Boolean(buttonByText('Create')),
        document.querySelector('[aria-label="Back to type selection"]') !== null,
      ],
      expected: [true, 'Untitled Document', true, true, true],
    });
  });

  test('Create posts the page to /api/pages in the drive, then opens its tab and closes the palette', async () => {
    spies.post.mockResolvedValue({ id: 'new-page' });
    mount(<QuickCreatePalette />);
    act(() => useUIStore.getState().openQuickCreate(null));
    act(() => optionByName('Document')?.click());
    typeInto(document.querySelector<HTMLInputElement>('#quick-create-name')!, 'Plan');
    await clickAsync(buttonByText('Create'));
    const body = spies.post.mock.calls[0]?.[1] as { title: string; type: string; driveId: string; parentId: string | null } | undefined;
    assert({
      given: 'a document named "Plan" in the drive root',
      should: 'POST it to /api/pages, open the new tab and close the palette',
      actual: [
        spies.post.mock.calls[0]?.[0],
        body && { title: body.title, type: body.type, driveId: body.driveId, parentId: body.parentId },
        spies.navigateToPage.mock.calls[0],
        useUIStore.getState().quickCreateOpen,
      ],
      expected: [
        '/api/pages',
        { title: 'Plan', type: 'DOCUMENT', driveId: 'd1', parentId: null },
        ['new-page', 'd1'],
        false,
      ],
    });
  });

  test('Back returns from the name step to the type list', () => {
    mount(<QuickCreatePalette />);
    act(() => useUIStore.getState().openQuickCreate(null));
    act(() => optionByName('Document')?.click());
    act(() => document.querySelector<HTMLElement>('[aria-label="Back to type selection"]')?.click());
    assert({
      given: 'the name step',
      should: 'return to the page type list',
      actual: document.querySelectorAll('[role="option"]').length,
      expected: 9,
    });
  });
});

describe('QuickCreatePalette upload step (IMC-9.9)', () => {
  test('File steps to "Upload a file": Upload stays disabled until a file is chosen, then uploads it', async () => {
    spies.uploadFileToS3.mockResolvedValue({ id: 'uploaded' });
    mount(<QuickCreatePalette />);
    act(() => useUIStore.getState().openQuickCreate(null));
    act(() => optionByName('File')?.click());
    const before = buttonByText('Upload')?.disabled;
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(picker, 'files', { value: [file], configurable: true });
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const after = buttonByText('Upload')?.disabled;
    const shown = [
      document.body.textContent?.includes('Upload a file'),
      document.body.textContent?.includes('notes.txt'),
    ];
    await clickAsync(buttonByText('Upload'));
    assert({
      given: 'the File type chosen, then a file picked',
      should: 'show "Upload a file" naming the file, keep Upload disabled until a file exists, then upload it to the drive',
      actual: [
        ...shown,
        before,
        after,
        spies.uploadFileToS3.mock.calls[0]?.[0] === file,
        spies.uploadFileToS3.mock.calls[0]?.[1],
      ],
      expected: [true, true, true, false, true, { driveId: 'd1', parentId: null, title: 'notes.txt' }],
    });
  });
});
