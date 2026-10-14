/**
 * The routes that mount Stripe's Payment Element (UI-6). They are the only pages that skip
 * Cross-Origin-Embedder-Policy (the js.stripe.com frames do not load under COEP credentialless),
 * so the list is path-exact: Settings (the create-organization dialog) and an org's Plan & seats
 * page (Reactivate). Pure; the middleware and the client share it.
 *
 * COEP belongs to the DOCUMENT, so a client-side navigation into one of these routes keeps the
 * previous page's COEP. Surfaces elsewhere therefore open payment with a full page load to
 * paymentRouteFor(...) (see documentAllowsPaymentElement).
 */
const PAYMENT_ROUTES: readonly RegExp[] = [/^\/settings$/, /^\/orgs\/[^/]+\/settings\/billing$/];

export const isPaymentElementRoute = (pathname: string): boolean => PAYMENT_ROUTES.some((r) => r.test(pathname));

export type PaymentSurface = { kind: 'create_org' } | { kind: 'reactivate'; orgId: string };

export function paymentRouteFor(surface: PaymentSurface): string {
  return surface.kind === 'create_org' ? '/settings?createOrg=1' : `/orgs/${surface.orgId}/settings/billing?reactivate=1`;
}

/** Whether THIS document was loaded on a payment route (so it was served without COEP). */
export function documentAllowsPaymentElement(): boolean {
  if (typeof window === 'undefined') return false;
  const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const loadedAt = entry?.name ? new URL(entry.name).pathname : window.location.pathname;
  return isPaymentElementRoute(loadedAt);
}
