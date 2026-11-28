// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TreePage } from '@/retained/hooks/usePageTree';
import FileView from './file-view';
const state = vi.hoisted(() => ({ tree: [] as TreePage[], isLoading: false, isError: false, retry: vi.fn() }));
vi.mock('@/retained/hooks/usePageTree', () => ({ usePageTree: () => state }));
vi.mock('@/retained/components/layout/middle-content/page-views/file/FileViewer', () => ({ default: ({ page }: { page: TreePage }) => <span role="img" aria-label={page.originalFileName} data-mime={page.mimeType} /> }));
afterEach(() => { cleanup(); state.tree = []; state.isLoading = false; state.isError = false; });
it('uses the matching authorized nested file metadata, rather than the generic page DTO', () => {
  state.tree = [{ id: 'folder', children: [{ id: 'file', mimeType: 'image/png', originalFileName: 'photo.png', children: [] }] }] as unknown as TreePage[];
  render(<FileView driveId="drive" pageId="file" />);
  expect(screen.getByRole('img', { name: 'photo.png' }).getAttribute('data-mime')).toBe('image/png');
});
it('withholds the viewer while loading and offers recovery when metadata cannot be read', () => {
  state.isLoading = true;
  const view = render(<FileView driveId="drive" pageId="file" />);
  expect(screen.queryByRole('img')).toBeNull();
  state.isLoading = false; state.isError = true;
  view.rerender(<FileView driveId="drive" pageId="file" />);
  expect(screen.getByText('Could not open this file')).toBeTruthy();
  expect(screen.queryByRole('img')).toBeNull();
});
