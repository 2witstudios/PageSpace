export function getExportContentDisposition(backupId: string): string {
  return `attachment; filename="backup-${backupId}.zip"`;
}
