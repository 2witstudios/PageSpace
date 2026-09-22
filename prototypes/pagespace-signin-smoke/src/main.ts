/**
 * Real-browser smoke for Phase 3 of "Sign in with PageSpace" (US4, US7):
 * a foreign-origin SPA configured ONLY by PAGESPACE_URL + PAGESPACE_CLIENT_ID
 * signs a user in through @pagespace/sdk, reads the token response
 * cross-origin, and calls the API as that user (auth.me, drives.list,
 * pages.list). Every step's outcome is written to the page and to
 * window.__smoke so a human or a Playwright run can read it back.
 */
import {
  isSignInError,
  PAGESPACE_CALLBACK_PATH,
  PageSpaceClient,
  type OAuthTokenProvider,
} from '@pagespace/sdk';

interface SmokeResult {
  step: string;
  ok: boolean;
  detail: unknown;
}

const results: SmokeResult[] = [];
(window as unknown as { __smoke: SmokeResult[] }).__smoke = results;

const app = document.querySelector<HTMLDivElement>('#app')!;

function record(step: string, ok: boolean, detail: unknown): void {
  results.push({ step, ok, detail });
  render();
}

function describe(error: unknown): string {
  if (isSignInError(error)) return `SignInError(${error.reason}${error.authorizationError ? `: ${error.authorizationError}` : ''})`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

let signedIn = false;

function render(): void {
  const log = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.step}\n${JSON.stringify(r.detail, null, 2)}`).join('\n\n');
  app.innerHTML = `
    ${signedIn ? '<button id="signout">Sign out (revoke)</button>' : `
      <label>Drive id to grant (optional — needed for pages.list)</label>
      <input id="drive" placeholder="e.g. abc123" value="${sessionStorage.getItem('smoke.drive') ?? ''}" />
      <div class="row"><button id="signin">Sign in with PageSpace</button></div>`}
    <h2>Results</h2>
    <pre id="log">${log.replace(/</g, '&lt;') || '(nothing yet)'}</pre>`;
  document.querySelector('#signin')?.addEventListener('click', () => void signIn());
  document.querySelector('#signout')?.addEventListener('click', () => void signOut());
}

// fromEnvironment: the two env vars + this page's origin + /auth/pagespace/callback.
const auth = PageSpaceClient.fromEnvironment({ env: import.meta.env });
record('fromEnvironment', true, { baseUrl: auth.baseUrl, clientId: auth.clientId, redirectUri: auth.redirectUri, scope: auth.scope });

async function signIn(): Promise<void> {
  const drive = document.querySelector<HTMLInputElement>('#drive')?.value.trim() ?? '';
  sessionStorage.setItem('smoke.drive', drive);
  const scope = drive ? `profile offline_access drive:${drive}:member` : 'profile offline_access';
  await auth.signInWithRedirect({ scope });
}

async function signOut(): Promise<void> {
  const result = await auth.signOut();
  record('signOut', result?.outcome === 'revoked', result);
  signedIn = false;
  render();
}

async function exercise(provider: OAuthTokenProvider): Promise<void> {
  signedIn = true;
  const client = new PageSpaceClient({ baseUrl: auth.baseUrl, auth: provider });
  try {
    const me = await client.auth.me({});
    record('auth.me', true, me);
  } catch (error) {
    record('auth.me', false, describe(error));
  }
  const drive = sessionStorage.getItem('smoke.drive') ?? '';
  if (drive) {
    try {
      const pages = await client.pages.list({ driveId: drive, ls: true });
      record('pages.list (granted drive)', true, { driveName: pages.driveName, count: pages.count, titles: pages.pages.map((page) => page.title) });
    } catch (error) {
      record('pages.list (granted drive)', false, describe(error));
    }
  }
}

async function main(): Promise<void> {
  let provider: OAuthTokenProvider | null = null;
  if (location.pathname === PAGESPACE_CALLBACK_PATH) {
    try {
      provider = await auth.handleRedirectCallback(location.href);
      record('handleRedirectCallback (code exchanged cross-origin)', true, 'OAuthTokenProvider returned');
    } catch (error) {
      record('handleRedirectCallback', false, describe(error));
    }
    history.replaceState(null, '', '/');
  } else {
    provider = auth.restore();
    record('restore', true, provider === null ? 'no session' : 'session restored');
  }
  if (provider !== null) await exercise(provider);
  render();
}

void main();
