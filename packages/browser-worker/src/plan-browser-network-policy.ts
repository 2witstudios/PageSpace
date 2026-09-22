export type BrowserPolicyRule = { readonly domain: string; readonly action: 'allow' | 'deny' };
export type BrowserNetworkPolicy = { readonly rules: readonly BrowserPolicyRule[] };

export type PlanBrowserNetworkPolicyOptions = { readonly allowedOrigins: readonly string[] | null };

export const planBrowserNetworkPolicy = (_options: PlanBrowserNetworkPolicyOptions): BrowserNetworkPolicy => {
  throw new Error('planBrowserNetworkPolicy: not implemented (RED)');
};
