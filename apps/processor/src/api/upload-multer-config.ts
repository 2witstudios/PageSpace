// The processor is an internal service only reachable via the web layer, which
// already enforces per-user tier limits via checkStorageQuota(). This limit is
// a backstop set to the maximum business-tier file size (100MB) so business
// users are never incorrectly rejected. Override with STORAGE_MAX_FILE_SIZE_MB.
export function getMaxFileSizeBytes(): number {
  const mb = parseInt(process.env.STORAGE_MAX_FILE_SIZE_MB || '100', 10);
  return (isNaN(mb) || mb <= 0 ? 100 : mb) * 1024 * 1024;
}
