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
 * cmd.exe's own command-line lexer treats these as separators/redirections —
 * even inside double quotes — regardless of how Node's spawn() passes argv.
 * The authorize URL comes from an untrusted discovery doc, so rather than
 * rely on escaping to neutralize every one of these, win32 refuses to hand
 * cmd a URL containing any of them at all (see `isWin32CmdUnsafe` below).
 */
const WIN32_CMD_METACHARACTERS = /[&|<>^"]/;

function isWin32CmdUnsafe(url: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && WIN32_CMD_METACHARACTERS.test(url);
}

function commandFor(
  url: string,
  platform: NodeJS.Platform,
): { readonly command: string; readonly args: readonly string[]; readonly windowsVerbatimArguments?: boolean } {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '""', url], windowsVerbatimArguments: true };
  }
  return { command: 'xdg-open', args: [url] };
}

export const openBrowser: OpenBrowser = (url: string) =>
  new Promise((resolve) => {
    if (isWin32CmdUnsafe(url, process.platform)) {
      resolve(false);
      return;
    }

    const { command, args, windowsVerbatimArguments } = commandFor(url, process.platform);

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: 'ignore', detached: true, windowsVerbatimArguments });
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
