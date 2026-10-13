// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unmountAll, mount } from '@/ui/test-support/dom';

const tree = vi.hoisted(() => ({ value: { tree: [] as { children: unknown[] }[], isLoading: false, isError: undefined as unknown } }));
vi.mock('@/retained/hooks/usePageTree', () => ({ usePageTree: () => tree.value }));
const { countPages, FilesIntro } = await import('./files-intro');

afterEach(unmountAll);

describe('countPages()', () => {
  it('counts every node at every depth', () => {
    expect(countPages([])).toBe(0);
    expect(countPages([
      { children: [{ children: [] }, { children: [{ children: [] }] }] },
      { children: [] },
    ])).toBe(5);
  });
});

describe('FilesIntro', () => {
  it('shows the page count, the drive name and a classic link', () => {
    tree.value = { tree: [{ children: [{ children: [] }] }, { children: [] }], isLoading: false, isError: undefined };
    const container = mount(<FilesIntro driveId="d1" driveName="Studio" />);
    expect(container.textContent).toBe('3 pages in Studio · Browse files');
    const link = container.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/dashboard/d1/files');
    expect(link?.textContent).toBe('Browse files');
  });

  it('shows nothing while the tree loads', () => {
    tree.value = { tree: [], isLoading: true, isError: undefined };
    const container = mount(<FilesIntro driveId="d1" driveName="Studio" />);
    expect(container.textContent).toBe('');
    expect(container.querySelector('a')).toBeNull();
  });

  it('shows nothing before the drive name is known', () => {
    tree.value = { tree: [{ children: [] }], isLoading: false, isError: undefined };
    const container = mount(<FilesIntro driveId="d1" driveName={undefined} />);
    expect(container.textContent).toBe('');
  });
});
