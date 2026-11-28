/**
 * Billing channel — which store, if any, may sell to this client.
 *
 * - `'stripe'`: web and Android, on a deployment with billing.
 * - `'apple'`: the iOS app, on a binary that ships the PageSpaceStore (StoreKit)
 *   plugin. Purchases go through In-App Purchase; Stripe surfaces stay hidden.
 * - `'none'`: no purchase surface at all — billing-disabled deployments, an iOS
 *   binary that predates the plugin (which still loads the remote web app), and
 *   every client before platform detection finishes.
 */
export type BillingChannel = 'stripe' | 'apple' | 'none';

export interface BillingChannelInput {
  billingEnabled: boolean;
  /** Platform detection has finished (false on the server and the first client render). */
  isReady: boolean;
  isIOS: boolean;
  /** The running binary can sell through StoreKit. Imago never does: its caller passes false. */
  storeKitAvailable: boolean;
}

/**
 * Resolve the billing channel. Pure.
 *
 * `'none'` until detection finishes: the unsafe direction is showing a purchase
 * surface we later retract (a Stripe CTA that flashes on iOS for a frame).
 */
export function resolveBillingChannel({
  billingEnabled,
  isReady,
  isIOS,
  storeKitAvailable,
}: BillingChannelInput): BillingChannel {
  if (!billingEnabled || !isReady) return 'none';
  if (isIOS) return storeKitAvailable ? 'apple' : 'none';
  return 'stripe';
}

/**
 * What a guarded billing page sells through.
 *
 * - `'stripe'`: Stripe-only pages (`/settings/billing`: portal, invoices,
 *   payment methods). Redirect everywhere but the Stripe channel.
 * - `'purchases'`: pages that can sell on either store (`/settings/plan`).
 *   Allowed on the Stripe and Apple channels.
 */
export type BillingSurface = 'stripe' | 'purchases';

/**
 * Whether BillingGuard should send the visitor away. Pure.
 *
 * Never redirects before detection finishes — doing so bounced web users off
 * their own billing pages. `hideBilling` is the legacy "billing is hidden here"
 * flag (true on iOS and billing-disabled deployments, once ready).
 */
export function shouldRedirectFromBillingSurface({
  surface,
  isReady,
  hideBilling,
  channel,
}: {
  surface: BillingSurface;
  isReady: boolean;
  hideBilling: boolean;
  channel: BillingChannel;
}): boolean {
  if (!isReady) return false;
  if (surface === 'purchases') return channel === 'none';
  // Stripe pages: hidden on iOS (Apple channel included) and billing-disabled
  // deployments — exactly where `hideBilling` is true once ready.
  return hideBilling;
}

/**
 * Returns the redirect destination when a user on iOS tries to access billing pages.
 */
export function getBillingRedirect(): string {
  return '/settings';
}
