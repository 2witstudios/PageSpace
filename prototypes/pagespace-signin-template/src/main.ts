/**
 * Sign in with PageSpace — the whole app.
 *
 * Configured by exactly two PUBLIC values the environment already provides,
 * PAGESPACE_URL and PAGESPACE_CLIENT_ID (handed to the page by
 * /pagespace-config.js). No key, no secret, no registration: the environment
 * this app is built in IS an OAuth client, and PageSpace maintains its
 * redirect URIs for the preview origin and, after publish, the published one.
 */
import { isSignInError, PAGESPACE_CALLBACK_PATH, PageSpaceClient, type OAuthTokenProvider } from '@pagespace/sdk';

declare global {
  interface Window {
    __PAGESPACE_ENV__?: { PAGESPACE_URL?: string; PAGESPACE_CLIENT_ID?: string };
  }
}

const app = document.querySelector<HTMLElement>('#app')!;

// fromEnvironment: the two public values + this page's origin + /auth/pagespace/callback.
// Throws a PageSpaceConfigError naming the missing variable — never work around it with a hardcoded value.
const auth = PageSpaceClient.fromEnvironment({ env: window.__PAGESPACE_ENV__ ?? {} });

function describe(error: unknown): string {
  if (isSignInError(error)) return `Sign-in failed: ${error.reason}`;
  return error instanceof Error ? error.message : String(error);
}

function render(html: string): void {
  app.innerHTML = html;
}

async function showSignedIn(provider: OAuthTokenProvider): Promise<void> {
  const client = new PageSpaceClient({ baseUrl: auth.baseUrl, auth: provider });
  const me = await client.auth.me({});
  render(`
    <p>Signed in as <strong>${escapeHtml(me.name ?? me.email)}</strong> (${escapeHtml(me.email)})</p>
    <button id="signout">Sign out</button>`);
  document.querySelector('#signout')?.addEventListener('click', async () => {
    await auth.signOut();
    showSignedOut();
  });
}

function showSignedOut(message?: string): void {
  render(`
    ${message ? `<p>${escapeHtml(message)}</p>` : ''}
    <button id="signin">Sign in with PageSpace</button>`);
  // profile = identity only, approved with a plain click. Add drive:<driveId>:member
  // only when the app reads or writes content in that drive.
  document.querySelector('#signin')?.addEventListener('click', () => void auth.signInWithRedirect({ scope: 'profile' }));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

async function main(): Promise<void> {
  let provider: OAuthTokenProvider | null = null;
  if (location.pathname === PAGESPACE_CALLBACK_PATH) {
    try {
      provider = await auth.handleRedirectCallback(location.href);
    } catch (error) {
      history.replaceState(null, '', '/');
      showSignedOut(describe(error));
      return;
    }
    history.replaceState(null, '', '/');
  } else {
    provider = auth.restore();
  }
  if (provider) await showSignedIn(provider);
  else showSignedOut();
}

void main();
