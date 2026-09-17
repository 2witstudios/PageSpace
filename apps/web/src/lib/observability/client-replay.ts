/**
 * Sentry Session Replay sampling for the browser bundle.
 *
 * Never in the native apps: they show no consent prompt, and App Review is told
 * the app does not record or analyse usage (Guidelines 5.1.2(i), 2.5.14).
 */
export function clientReplaySampling({ isNative }: { isNative: boolean }): {
  enabled: boolean;
  replaysSessionSampleRate: number;
  replaysOnErrorSampleRate: number;
} {
  if (isNative) return { enabled: false, replaysSessionSampleRate: 0, replaysOnErrorSampleRate: 0 };
  return { enabled: true, replaysSessionSampleRate: 0.1, replaysOnErrorSampleRate: 1.0 };
}
