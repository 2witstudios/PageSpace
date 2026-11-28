/**
 * Which desktop app a native auth flow should hand back to.
 *
 * One Electron codebase ships two apps — PageSpace and PageSpace Coder — and
 * each registers its own protocol scheme with the OS. Deep links carry
 * single-use auth exchange codes, so a flow started in one app must return to
 * that app: sending a Coder sign-in to `pagespace://` would either land in the
 * wrong app or, if PageSpace is not installed, nowhere at all.
 *
 * The variant is carried as an enum, never as a scheme string. A caller-supplied
 * scheme would make every one of these builders an arbitrary-scheme redirect.
 * Anything unrecognized — including an older shell that sends nothing — resolves
 * to PageSpace, which is the behaviour that predates the second app.
 */

export const DESKTOP_SHELLS = ['pagespace', 'coder'] as const;

export type DesktopShell = (typeof DESKTOP_SHELLS)[number];

const SCHEMES: Record<DesktopShell, string> = {
  pagespace: 'pagespace',
  coder: 'pagespace-coder',
};

export const DEFAULT_DESKTOP_SHELL: DesktopShell = 'pagespace';

/** Narrow an untrusted value to a known shell, or `undefined` if it is not one. */
export function parseDesktopShell(value: unknown): DesktopShell | undefined {
  return DESKTOP_SHELLS.includes(value as DesktopShell) ? (value as DesktopShell) : undefined;
}

/** The protocol scheme, without a colon, for the given shell. */
export function desktopShellScheme(shell: unknown): string {
  return SCHEMES[parseDesktopShell(shell) ?? DEFAULT_DESKTOP_SHELL];
}

/**
 * Build a deep link back into the desktop app that started the flow.
 * `host` is the deep-link host the main process dispatches on — `auth-exchange`,
 * `auth-error` or `passkey-registered`.
 */
export function desktopDeepLink(shell: unknown, host: string): string {
  return `${desktopShellScheme(shell)}://${host}`;
}

/**
 * The shell this page is running inside, or `undefined` on the web.
 *
 * Reads the preload bridge directly rather than `isDesktopPlatform()` so it is
 * safe on the server and in the external browser, where the bridge is absent
 * and the caller must fall back to whatever the URL told it.
 */
export function currentDesktopShell(): DesktopShell | undefined {
  if (typeof window === 'undefined') return undefined;
  return parseDesktopShell(window.electron?.appVariant);
}
