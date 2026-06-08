export function getExportFilename(backupId: string, label: string | null | undefined): string {
  return label ? `${label}.zip` : `backup-${backupId}.zip`;
}

export function getDownloadButtonLabel(isDownloading: boolean): string {
  return isDownloading ? 'Downloading…' : 'Download';
}
