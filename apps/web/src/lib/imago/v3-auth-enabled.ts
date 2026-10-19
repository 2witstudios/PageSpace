/**
 * Whether signed-out and edge pages (sign-in, sign-up, invites, consent, ...) use the
 * Imago v3 look and send post-flow redirects to /imago. Separate from
 * NEXT_PUBLIC_IMAGO_ENABLED, which only controls the "Try Imago" link: the Imago preview
 * can be live while these pages stay classic. NEXT_PUBLIC_IMAGO_V3_AUTH is inlined at
 * build time, so it must be read as a literal property access. Only the exact value
 * 'true' enables it.
 */
export function isV3AuthEnabled(): boolean {
  return process.env.NEXT_PUBLIC_IMAGO_V3_AUTH === 'true';
}
