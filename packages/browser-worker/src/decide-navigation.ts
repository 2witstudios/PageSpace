export type NavigationDenyReason =
  | 'invalid-url'
  | 'scheme-not-allowed'
  | 'credentials-in-url'
  | 'internal-host'
  | 'private-address'
  | 'unresolved'
  | 'origin-not-allowed';

export type TransportOrigin = {
  readonly secure: boolean;
  readonly host: string;
  readonly port: number;
};

export type NavigationVerdict =
  | { readonly verdict: 'allow'; readonly transportOrigin: TransportOrigin; readonly connectAddress: string }
  | { readonly verdict: 'resolve'; readonly host: string }
  | { readonly verdict: 'deny'; readonly reason: NavigationDenyReason };

export type DecideNavigationOptions = {
  readonly url: string;
  readonly resolvedAddresses: readonly string[] | null;
  readonly allowedOrigins: readonly string[] | null;
};

export const decideNavigation = (_options: DecideNavigationOptions): NavigationVerdict => {
  throw new Error('decideNavigation: not implemented (RED)');
};
