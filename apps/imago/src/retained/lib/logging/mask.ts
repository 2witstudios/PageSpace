export function maskIdentifier(identifier?: string | null): string | undefined {
  if (!identifier) {
    return undefined;
  }

  // Sanitize BEFORE masking: identifiers are caller-provided and reach log
  // sinks — strip anything outside the id alphabet (kills newlines/control
  // chars, i.e. log-injection payloads) rather than just truncating them.
  const normalized = String(identifier).replace(/[^a-zA-Z0-9_-]/g, '');
  if (normalized.length === 0) {
    return undefined;
  }
  if (normalized.length <= 8) {
    return normalized;
  }

  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}
