'use client';

// The Files section's ground (IMC-2.12): with no page open, the chat column
// opens with how many pages the drive holds and a way into classic's file
// browser. The count comes from the retained page tree, so the line stays
// hidden until that tree has loaded.

import { usePageTree } from '@/retained/hooks/usePageTree';

/** Any node of a page tree; counts every node, however deep. */
export type PageNode = { readonly children: readonly PageNode[] };

/** The number of pages in a tree: every node, at every depth. */
export const countPages = (tree: readonly PageNode[]): number =>
  tree.reduce((total, page) => total + 1 + countPages(page.children), 0);

export const filesIntroClass = 'px-4 py-2 text-sm text-ink-muted';

export type FilesIntroProps = {
  readonly driveId: string;
  /** The drive's name; the line stays hidden until it is known. */
  readonly driveName: string | undefined;
};

export function FilesIntro({ driveId, driveName }: FilesIntroProps) {
  const { tree, isLoading, isError } = usePageTree(driveId);
  if (isLoading || isError || driveName === undefined) return null;
  return (
    <p className={filesIntroClass}>
      {countPages(tree)} {countPages(tree) === 1 ? 'page' : 'pages'} in {driveName} · <a className="underline" href={`/dashboard/${encodeURIComponent(driveId)}/files`}>Browse files</a>
    </p>
  );
}
