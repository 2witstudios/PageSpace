/** Edge-safe storage allowlist shared by the authenticated UIs.
 * Mirrors the existing presigned-upload endpoint and bucket addressing rule;
 * never grants a wildcard across other buckets on the storage provider.
 */
export function storageCspSources(endpoint: string | undefined, bucket: string): string[] {
  if (!endpoint) return [];
  try {
    const { protocol, host } = new URL(endpoint);
    if (!['http:', 'https:'].includes(protocol) || !/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) return [];
    if (!/^[A-Za-z0-9.-]+$/.test(bucket)) return [];
    return [`${protocol}//${host}`, `${protocol}//${bucket}.${host}`];
  } catch {
    return [];
  }
}
