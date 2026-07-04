/**
 * Cross-platform browser opener (Phase 4 task 3). Spawns the OS's native
 * "open a URL" command detached, so the CLI never blocks on the browser
 * process. Resolves `false` (never throws) on any failure — missing binary,
 * headless/SSH box with no display, unsupported platform — so the caller can
 * fall back to printing the URL for manual copy.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import type { OpenBrowser } from './loopback-flow.js';

/**
 * `cmd /c start` was the original win32 approach, but cmd.exe's own
 * command-line lexer treats `&`, `|`, `<`, `>`, `^` as separators/
 * redirections — and the authorize URL (untrusted discovery-doc input)
 * always contains multiple `&`-joined query params (see
 * loopback-flow.ts's buildAuthorizeUrl), so cmd would never see the whole
 * URL as one argument. Escaping every metacharacter cmd's lexer recognizes
 * is fragile and easy to get subtly wrong; refusing to open whenever a
 * metacharacter is present would disable auto-open for effectively every
 * real login. Instead, bypass cmd.exe entirely: `rundll32.exe
 * url.dll,FileProtocolHandler <url>` is a normal argv-parsing Win32 binary
 * (standard CommandLineToArgvW convention — only `"`/`\` are special, not
 * shell metacharacters), which Node's default (non-verbatim) argument
 * quoting already handles safely.
 */
function commandFor(url: string, platform: NodeJS.Platform): { readonly command: string; readonly args: readonly string[] } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', url] };
  return { command: 'xdg-open', args: [url] };
}

export const openBrowser: OpenBrowser = (url: string) =>
  new Promise((resolve) => {
    const { command, args } = commandFor(url, process.platform);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true });
    } catch {
      resolve(false);
      return;
    }

    let settled = false;
    child.once('error', () => {
      if (settled) return;
      settled = true;
      resolve(false);
    });
    child.once('spawn', () => {
      if (settled) return;
      settled = true;
      child.unref();
      resolve(true);
    });
  });
