export function getExportFilename(
  backupId: string,
  label: string | null | undefined,
  driveSlug?: string | null,
): string {
  const slug = driveSlug ? `${driveSlug}-` : '';
  return label ? `${slug}${label}.zip` : `${slug}backup-${backupId}.zip`;
}

export function getDownloadButtonLabel(isDownloading: boolean): string {
  return isDownloading ? 'Downloading…' : 'Download';
}
