import { isCapacitorApp } from '@/lib/capacitor-bridge';
import { openExternalUrl } from './app-navigation';

/**
 * Send the user to a third-party OAuth consent screen (Google Calendar, Slack, …).
 *
 * In the native app the consent screen opens in the system browser sheet: Google
 * refuses to render it inside an embedded web view (`disallowed_useragent`), and
 * the shell has no back gesture to escape the error page. The callbacks verify a
 * signed `state`, not a session cookie, so the connection completes in the sheet
 * and the user returns to the app with Done. The web navigates the page as before.
 */
export async function startThirdPartyOAuth(url: string): Promise<void> {
  if (isCapacitorApp()) {
    await openExternalUrl(url);
    return;
  }
  window.location.href = url;
}
