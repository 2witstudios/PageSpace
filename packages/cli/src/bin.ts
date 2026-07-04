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
import { run } from './run.js';

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

run({
  argv: process.argv.slice(2),
  env: process.env,
  stdout,
  stderr,
  credentialStore: createCredentialStore({ stderr }),
  isTTY: process.stdin.isTTY === true,
  prompt,
})
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
