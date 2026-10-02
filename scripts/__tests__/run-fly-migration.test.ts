import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Exercises the REAL script (not a reimplementation) with fake flyctl/docker/curl
// executables shadowing PATH, so the test proves actual exit-code behavior rather
// than source-text presence (the assertion style CodeRabbit flagged in the
// docker-images.yml guard test).

const SCRIPT = resolve(__dirname, '../deploy/run-fly-migration.sh');

let binDir: string;
let stateResponsePath: string;

function writeFakeExecutable(name: string, body: string) {
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'run-fly-migration-fakebin-'));
  stateResponsePath = join(binDir, 'state-response.json');

  writeFakeExecutable('docker', 'exit 0');

  writeFakeExecutable(
    'flyctl',
    `
case "$*" in
  "machine run"*) echo "Machine ID: fake0001234"; exit 0 ;;
  "machine destroy"*) exit 0 ;;
  "machine logs"*) exit 0 ;;
  *) exit 0 ;;
esac
`
  );

  // Mimics `curl -s -o <file> -w "%{http_code}" <url>`: writes the canned Machines
  // API response to the -o file and prints "200" to stdout (the polled HTTP code).
  writeFakeExecutable(
    'curl',
    `
outfile=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then outfile="$arg"; fi
  prev="$arg"
done
cp "${stateResponsePath}" "$outfile"
printf '200'
`
  );
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
});

function runScript() {
  return spawnSync(SCRIPT, ['pagespace-web', 'ghcr.io/2witstudios/pagespace-migrate', 'sha-abc1234'], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      FLY_API_TOKEN: 'fake-token',
    },
    encoding: 'utf-8',
  });
}

describe('run-fly-migration.sh — machine exit-code handling', () => {
  it('given the machine reaches stopped with exit code 0, should report success', () => {
    writeFileSync(
      stateResponsePath,
      JSON.stringify({
        id: 'fake0001234',
        state: 'stopped',
        events: [{ type: 'exit', request: { exit_event: { exit_code: 0, exit_signal: 0 } } }],
      })
    );

    const result = runScript();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Migrations complete');
  });

  it('given the machine reaches stopped with a non-zero exit code, should treat it as a failure', () => {
    writeFileSync(
      stateResponsePath,
      JSON.stringify({
        id: 'fake0001234',
        state: 'stopped',
        events: [{ type: 'exit', request: { exit_event: { exit_code: 1, exit_signal: 0 } } }],
      })
    );

    const result = runScript();

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('Migrations complete');
  });

  it('given the machine reaches stopped with a missing exit code, should treat it as a failure (fail closed)', () => {
    writeFileSync(
      stateResponsePath,
      JSON.stringify({
        id: 'fake0001234',
        state: 'stopped',
        events: [],
      })
    );

    const result = runScript();

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain('Migrations complete');
  });
});
