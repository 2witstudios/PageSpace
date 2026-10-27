import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Exercises the REAL script (not a reimplementation) with fake flyctl/docker/curl
// executables shadowing PATH, so the test proves actual exit-code behavior rather
// than source-text presence (the assertion style CodeRabbit flagged in the
// docker-images.yml guard test).

const SCRIPT = resolve(__dirname, '../deploy/run-fly-migration.sh');

const MACHINE_ID = 'fa1e0001234';

let binDir: string;
let stateResponsePath: string;
let callsPath: string;
let machineRunOutput: string;

function writeFakeExecutable(name: string, body: string) {
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'run-fly-migration-fakebin-'));
  stateResponsePath = join(binDir, 'state-response.json');
  callsPath = join(binDir, 'calls.txt');
  machineRunOutput = join(binDir, 'machine-run-output.txt');
  writeFileSync(machineRunOutput, `Machine ID: ${MACHINE_ID}\n`);

  writeFakeExecutable('docker', 'exit 0');
  // The poll loop sleeps 10s between Machines API reads; the deadline is counted in
  // loop iterations, so a no-op sleep exercises the full 900s budget instantly.
  writeFakeExecutable('sleep', 'exit 0');

  writeFakeExecutable(
    'flyctl',
    `
echo "flyctl $*" >> "${callsPath}"
case "$*" in
  "machine run"*) cat "${machineRunOutput}"; exit 0 ;;
  *) exit 0 ;;
esac
`
  );

  // Mimics the Machines API: GET .../machines/<id> writes the canned machine response
  // to the -o file and prints "200" (the polled HTTP code); GET .../machines (the
  // by-name fallback) prints a machine list. Any other URL — e.g. a truncated machine
  // ID — is rejected, so the test proves the script polls the full ID.
  writeFakeExecutable(
    'curl',
    `
outfile=""
prev=""
url=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then outfile="$arg"; fi
  case "$arg" in
    https://api.machines.dev/*) url="$arg" ;;
  esac
  prev="$arg"
done
case "$url" in
  https://api.machines.dev/v1/apps/pagespace-web/machines/${MACHINE_ID})
    cp "${stateResponsePath}" "$outfile"
    printf '200' ;;
  https://api.machines.dev/v1/apps/pagespace-web/machines)
    printf '[{"id":"0ther0000000","name":"other"},{"id":"${MACHINE_ID}","name":"%s"}]' "$(grep -o 'migrations-[0-9]*' "${callsPath}" | head -1)" ;;
  *) exit 2 ;;
esac
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
      DIAGNOSTICS_DIR: join(binDir, 'diagnostics'),
    },
    encoding: 'utf-8',
  });
}

// 90 polls with stubbed sleep, each forking jq — slower than vitest's default 5s.
describe('run-fly-migration.sh — machine exit-code handling', { timeout: 120_000 }, () => {
  it('given the machine reaches stopped with exit code 0, should report success', () => {
    writeFileSync(
      stateResponsePath,
      JSON.stringify({
        id: MACHINE_ID,
        state: 'stopped',
        events: [{
          type: 'exit',
          timestamp: 1,
          request: { exit_event: { exited_at: '2026-10-15T18:40:30.498Z', exit_code: 0, signal: -1 } },
        }],
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
        id: MACHINE_ID,
        state: 'stopped',
        events: [{
          type: 'exit',
          timestamp: 1,
          request: { exit_event: { exited_at: '2026-10-15T18:40:30.498Z', exit_code: 1, signal: -1 } },
        }],
      })
    );

    const result = runScript();

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('exit evidence indicates failure');
    expect(result.stdout).not.toContain('Migrations complete');
  });

  it('given the machine reaches stopped but exit evidence never arrives, should time out as a failure (fail closed)', () => {
    writeFileSync(
      stateResponsePath,
      JSON.stringify({
        id: MACHINE_ID,
        state: 'stopped',
        events: [],
      })
    );

    const result = runScript();

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Exit evidence pending');
    expect(result.stdout).toContain('timed out after 900s');
    expect(result.stdout).not.toContain('Migrations complete');
  });
  it.each(['failed', 'destroyed'])('given the machine reaches the %s state, should fail and destroy the machine', (state) => {
    writeFileSync(stateResponsePath, JSON.stringify({ id: MACHINE_ID, state, events: [] }));

    const result = runScript();

    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain(`migration machine reached ${state} state`);
    expect(result.stdout).not.toContain('Migrations complete');
    expect(readFileSync(callsPath, 'utf-8')).toContain(`flyctl machine destroy ${MACHINE_ID} --app pagespace-web --force`);
  });

  it('given a successful run, should still destroy the one-shot machine', () => {
    writeFileSync(
      stateResponsePath,
      JSON.stringify({
        id: MACHINE_ID,
        state: 'stopped',
        events: [{ type: 'exit', timestamp: 1, request: { exit_event: { exited_at: '2026-10-15T18:40:30.498Z', exit_code: 0 } } }],
      })
    );

    const result = runScript();

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(callsPath, 'utf-8')).toContain(`flyctl machine destroy ${MACHINE_ID} --app pagespace-web --force`);
  });

  it('given flyctl output without a parsable machine ID, should find the machine by name and destroy it', () => {
    writeFileSync(machineRunOutput, 'Created machine (new output format)\n');

    const result = runScript();

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('could not parse machine ID');
    expect(readFileSync(callsPath, 'utf-8')).toContain(`flyctl machine destroy ${MACHINE_ID} --app pagespace-web --force`);
  });
});
