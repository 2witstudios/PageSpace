import { MagicLinkRedeem } from '@/components/auth/MagicLinkRedeem';

interface MagicLinkPageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ next?: string | string[] }>;
}

/**
 * Where a magic link requested from the iOS / Android app lands.
 *
 * The emailed link is `https://pagespace.ai/auth/magic-link/<token>`, claimed
 * in the AASA so the tap opens the app; `DeepLinkHandler` routes it here with
 * the router. The client half redeems the token with a same-origin POST so
 * the session lands in the WebView (cookie) and, on the bound device, in the
 * Keychain (bearer). Opened in a plain browser instead, the same page signs
 * that browser in — a link must never be dead just because it was tapped
 * somewhere else.
 *
 * Mirrors `/invite/[token]`: params are a single opaque segment, and the
 * resolver in `lib/navigation/deep-links.ts` only routes that shape.
 */
export default async function MagicLinkPage({ params, searchParams }: MagicLinkPageProps) {
  const { token } = await params;
  const { next } = await searchParams;
  const nextPath = typeof next === 'string' ? next : undefined;
  return <MagicLinkRedeem token={token} next={nextPath} />;
}
