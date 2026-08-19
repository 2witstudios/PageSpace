/**
 * Build-time app identity.
 *
 * One desktop codebase ships two applications: "PageSpace" (the general
 * knowledge-management shell, opening on `/dashboard`) and "PageSpace Coder"
 * (the same shell pointed at the Agents console). Everything that differs
 * between them lives in this registry, so the shell itself — fetch proxy,
 * navigation guard, MCP manager, auth storage — exists exactly once.
 *
 * This module is deliberately PURE: no `electron`, no `process.env`, no
 * build-time `define`. Selection happens in `src/main/app-identity.ts`. Keeping
 * the data pure is what lets `src/shared/navigation-guard.ts` stay free of
 * main-process imports and lets the variants be compared against each other in
 * a unit test.
 */

export const APP_VARIANTS = ['pagespace', 'coder'] as const;

export type AppVariant = (typeof APP_VARIANTS)[number];

export type AppIdentity = Readonly<{
  /** Which of the two apps this build is. */
  variant: AppVariant;
  /** electron-builder `appId` — must match the packaging config. */
  appId: string;
  /**
   * electron-builder `productName`. Also the packaged `app.getName()`, which is
   * what gives each app its own userData directory, single-instance lock and
   * `safeStorage` keychain entry.
   */
  productName: string;
  /** Human-facing name in menu, tray and updater dialogs. */
  displayName: string;
  /** OS protocol scheme registered for deep links, without the colon. */
  protocolScheme: string;
  /** `${protocolScheme}:` — matches `new URL(...).protocol`. */
  deepLinkScheme: string;
  /** `${protocolScheme}://` — matches a raw argv deep-link argument. */
  deepLinkPrefix: string;
  /** Path the shell loads on the app origin at cold launch. */
  startPath: string;
  /** Directory under `apps/desktop/` holding this app's icons. */
  iconDir: string;
  /** Tray icon filename within `iconDir`. */
  trayIconFile: string;
}>;

type AppIdentityInput = Omit<AppIdentity, 'variant' | 'deepLinkScheme' | 'deepLinkPrefix'>;

function define(variant: AppVariant, input: AppIdentityInput): AppIdentity {
  return Object.freeze({
    ...input,
    variant,
    deepLinkScheme: `${input.protocolScheme}:`,
    deepLinkPrefix: `${input.protocolScheme}://`,
  });
}

// Not exported: `knip.json` ignores `src/**/__tests__/**` for this workspace, so
// a record exported solely for tests would be reported as an unused export.
// Tests reach the variants through `resolveAppIdentity`.
const IDENTITIES: Record<AppVariant, AppIdentity> = {
  pagespace: define('pagespace', {
    appId: 'com.pagespace.app',
    productName: 'PageSpace',
    displayName: 'PageSpace',
    protocolScheme: 'pagespace',
    startPath: '/dashboard',
    iconDir: 'assets',
    trayIconFile: 'tray-icon.png',
  }),
  coder: define('coder', {
    appId: 'com.pagespace.coder',
    productName: 'PageSpace Coder',
    displayName: 'PageSpace Coder',
    protocolScheme: 'pagespace-coder',
    startPath: '/dashboard/agents',
    iconDir: 'assets/coder',
    trayIconFile: 'tray-icon.png',
  }),
};

/**
 * Resolve a variant name to its identity, falling back to `pagespace` for an
 * absent or unrecognized value. Fails soft on purpose: an unbuilt or misspelled
 * variant should produce the existing app, never a half-configured one.
 */
export function resolveAppIdentity(variant: string | undefined | null): AppIdentity {
  if (typeof variant !== 'string') return IDENTITIES.pagespace;
  return IDENTITIES[variant as AppVariant] ?? IDENTITIES.pagespace;
}
