/**
 * Why `getUserMedia` failed, and what to tell the user about it.
 *
 * Extracted from `useVoiceMode` rather than reimplemented alongside it: the
 * audio-native path asks for the same microphone through the same API and hits
 * the same five failures, and the desktop branch below is the reason a fresh
 * port would be a regression. In an Electron shell a blocked prompt is NOT
 * fixable in browser settings — the block lives in macOS System Settings, and a
 * message that says "check your browser settings" sends the user somewhere that
 * has no such control.
 *
 * Denied and missing are DIFFERENT outcomes on purpose. They look identical on
 * screen ("voice didn't start") and need opposite advice: one is a permission to
 * grant, the other is hardware to plug in.
 *
 * Pure: `classifyMicFailure` and `micFailureMessage` do no I/O and read no
 * globals. `isDesktopShell` is the one environment read, isolated so the message
 * table can be tested for both shells without a fake `window`.
 */

export type MicFailure =
  /** The prompt was refused, or a policy refuses it standing. */
  | 'denied'
  /** No capture device exists to grant. */
  | 'missing'
  /** A device exists but another app holds it. */
  | 'busy'
  /** This browser has no `getUserMedia` to call. */
  | 'unsupported'
  | 'unknown';

/**
 * Classified by `name`, not by `instanceof DOMException`: the spec-named errors
 * are what identify the failure, and narrowing to one constructor first means a
 * correctly-named error thrown by a shim or a test double falls through to the
 * generic message.
 */
export const classifyMicFailure = (error: unknown): MicFailure => {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? (error as { name?: unknown }).name
      : undefined;

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'denied';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'missing';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'busy';
    // A missing `navigator.mediaDevices` is a TypeError, not a DOMException:
    // the capability is absent rather than refused.
    case 'TypeError':
      return 'unsupported';
    default:
      return 'unknown';
  }
};

/** Whether this is the Electron desktop shell, where "browser settings" is wrong advice. */
export const isDesktopShell = (): boolean =>
  typeof window !== 'undefined' && !!window.electron?.isDesktop;

export const micFailureMessage = (
  failure: MicFailure,
  isDesktop: boolean,
): string => {
  switch (failure) {
    case 'denied':
      return isDesktop
        ? 'Microphone access was blocked. Allow PageSpace in System Settings > Privacy & Security > Microphone, then try again.'
        : 'Microphone access was blocked. Please allow microphone permissions in your browser settings and try again.';
    case 'missing':
      return 'No microphone was detected. Connect a microphone and try again.';
    case 'busy':
      return 'Your microphone is busy in another app. Close other apps using the mic and try again.';
    case 'unsupported':
      return 'This browser does not support microphone capture for voice mode.';
    case 'unknown':
      return 'Unable to start voice mode because microphone access failed. Please try again.';
  }
};

/**
 * The one call site both voice paths use. `isDesktop` is a parameter with an
 * environment-reading default so the table above stays testable in both shells.
 */
export const getMicPermissionErrorMessage = (
  error: unknown,
  isDesktop: boolean = isDesktopShell(),
): string => micFailureMessage(classifyMicFailure(error), isDesktop);
