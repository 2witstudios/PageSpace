export function maskIdentifier(identifier?: string | null): string | undefined {
  if (!identifier) {
    return undefined;
  }

  const normalized = String(identifier);
  if (normalized.length <= 8) {
    return normalized;
  }

  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}
