/**
 * Whether the Imago (v3) UI is rolled out. NEXT_PUBLIC_IMAGO_ENABLED is inlined at
 * build time, so it must be read as a literal property access. Only the exact value
 * 'true' enables it; classic-only deployments keep the classic look.
 */
export function isImagoEnabled(): boolean {
  return process.env.NEXT_PUBLIC_IMAGO_ENABLED === 'true';
}
