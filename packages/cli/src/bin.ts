#!/usr/bin/env node
/**
 * The one file allowed to touch `process.*`. Everything else — parsing,
 * config resolution, routing, handlers — is pure or takes its effects
 * injected, so it can be unit-tested without a real process.
 */
import process from 'node:process';
import * as readline from 'node:readline/promises';
import { createCredentialStore } from './credentials/store.js';
import type { OutputSink } from './handler-context.js';
import { isLongRunningCommand, run } from './run.js';

const stdout: OutputSink = { write: (chunk) => { process.stdout.write(chunk); } };
const stderr: OutputSink = { write: (chunk) => { process.stderr.write(chunk); } };

async function prompt(message: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

/**
 * Flush both stdio streams (write-with-callback), then force the exit. A
 * bare `process.exit()` can truncate output still buffered on a pipe
 * (`pagespace ... | head`); a bare `process.exitCode` leaves the exit at the
 * mercy of every lingering handle — prompt-library stdin state, HTTP
 * keep-alive sockets — turning "command finished" into a hang. One-shot
 * commands get the flush-then-exit; only `pagespace mcp` (a live stdio
 * server whose handler resolves at connect time) must be left running, which
 * `isLongRunningCommand` gates below.
 */
function flushAndExit(code: number): void {
  let remaining = 2;
  const finish = () => {
    remaining -= 1;
    if (remaining === 0) process.exit(code);
  };
  process.stdout.write('', finish);
  process.stderr.write('', finish);
}

const argv = process.argv.slice(2);

run({
  argv,
  env: process.env,
  stdout,
  stderr,
  credentialStore: createCredentialStore({ stderr }),
  isTTY: process.stdin.isTTY === true,
  prompt,
})
  .then((code) => {
    // Long-running commands are exempt from the force-exit ONLY when they
    // actually reached their long-running state: `pagespace mcp` resolves
    // EXIT_SUCCESS exactly when the stdio server connected (commands/mcp.ts),
    // while every failure path (no explicit credential, enforceAuth refresh
    // failure, unknown subcommand) resolves nonzero WITHOUT a server — those
    // must flush-and-exit like any one-shot command, or the mcp command's own
    // error paths reintroduce the lingering-handle hang this fixes.
    if (code === 0 && isLongRunningCommand(argv)) {
      process.exitCode = code;
      return;
    }
    flushAndExit(code);
  })
  .catch((error: unknown) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    flushAndExit(1);
  });
