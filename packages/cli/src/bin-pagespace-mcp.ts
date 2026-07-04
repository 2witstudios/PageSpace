#!/usr/bin/env node
/**
 * The deprecated `pagespace-mcp` bin alias (Phase 6 task 3). Mirrors
 * `bin.ts`'s process wiring exactly, but delegates all argv/route/deprecation
 * logic to the pure `runLegacyMcpBin` in `legacy-bin.ts` — this file only
 * touches `process.*`.
 */
import process from 'node:process';
import { createCredentialStore } from './credentials/store.js';
import type { OutputSink } from './handler-context.js';
import { runLegacyMcpBin } from './legacy-bin.js';

const stdout: OutputSink = { write: (chunk) => { process.stdout.write(chunk); } };
const stderr: OutputSink = { write: (chunk) => { process.stderr.write(chunk); } };

runLegacyMcpBin({
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
