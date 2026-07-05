#!/usr/bin/env node
/**
 * The `pagespace-mcp` bin — a first-class, zero-install way to run the
 * `pagespace mcp` stdio server via `npx -y @pagespace/cli pagespace-mcp`.
 * Mirrors `bin.ts`'s process wiring exactly, but delegates all argv/route
 * logic to the pure `runPagespaceMcpBin` in `pagespace-mcp-bin.ts` — this
 * file only touches `process.*`.
 */
import process from 'node:process';
import { createCredentialStore } from './credentials/store.js';
import type { OutputSink } from './handler-context.js';
import { runPagespaceMcpBin } from './pagespace-mcp-bin.js';

const stdout: OutputSink = { write: (chunk) => { process.stdout.write(chunk); } };
const stderr: OutputSink = { write: (chunk) => { process.stderr.write(chunk); } };

runPagespaceMcpBin({
  argv: process.argv.slice(2),
  env: process.env,
  stdout,
  stderr,
  credentialStore: createCredentialStore({ stderr }),
  isTTY: false,
  prompt: async () => '',
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
