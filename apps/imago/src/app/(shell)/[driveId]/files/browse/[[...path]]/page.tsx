import type { ReactNode } from 'react';
import { getViewer } from '@/lib/auth/get-viewer';
import { FilesBrowser } from '@/ui/files/files-browser/files-browser';

type Props = { readonly params: Promise<{ driveId: string; path?: string[] }> };

/**
 * Stage 3: the folder browser in the object column. The path is the folder's
 * ids from the top of the drive down; no path is the drive's top. The browser
 * draws the folder the drive tree lists there, and not-found for any other.
 */
export default async function Page({ params }: Props): Promise<ReactNode> {
  const [{ driveId, path }] = await Promise.all([params, getViewer()]);
  return <FilesBrowser driveId={driveId} folderIds={path ?? []} />;
}
