// The folder browser's writes, through the same apps/web routes classic's
// row menu calls: rename and trash a page, and upload files into a folder.

import type { ApiClient } from '@/api/client';
import { uploadFileToS3 } from '@/retained/lib/upload/orchestrator';

/** PATCH /api/pages/[pageId] with the new title, as classic's Rename does. */
export const renamePage = (client: ApiClient, pageId: string, title: string): Promise<unknown> =>
  client.apiFetch(`/api/pages/${encodeURIComponent(pageId)}`, { method: 'PATCH', json: { title } });

/** DELETE /api/pages/[pageId] (moves it to the trash), with or without its children, as classic's Trash does. */
export const trashPage = (client: ApiClient, pageId: string, trashChildren: boolean): Promise<unknown> =>
  client.apiFetch(`/api/pages/${encodeURIComponent(pageId)}`, {
    method: 'DELETE',
    json: { trash_children: trashChildren },
  });

export type UploadOutcome = { readonly uploaded: number; readonly failed: readonly string[] };

/**
 * Uploads files into a folder (null: the top of the drive). The viewer's
 * storage is checked for the whole drop first, as classic's drop does; each
 * file then goes up on its own, and one that fails is named in the outcome.
 */
export const uploadFiles = async (
  client: ApiClient,
  files: readonly File[],
  target: { readonly driveId: string; readonly parentId: string | null },
): Promise<UploadOutcome> => {
  if (files.length === 0) return { uploaded: 0, failed: [] };
  const fileSize = files.reduce((total, file) => total + file.size, 0);
  await client.apiFetch('/api/storage/check', { method: 'POST', json: { fileSize } });
  let uploaded = 0;
  const failed: string[] = [];
  for (const file of files) {
    try {
      await uploadFileToS3(file, target);
      uploaded += 1;
    } catch {
      failed.push(file.name);
    }
  }
  return { uploaded, failed };
};
