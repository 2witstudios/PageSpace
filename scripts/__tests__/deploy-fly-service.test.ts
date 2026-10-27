import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Exercises the REAL script with fake docker/flyctl executables shadowing PATH and
// records the flyctl invocation, so the test proves which image and config are
// actually deployed.

const SCRIPT = resolve(__dirname, '../deploy/deploy-fly-service.sh');

let binDir: string;
let callsPath: string;

function writeFakeExecutable(name: string, body: string) {
  const path = join(binDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

beforeEach(() => {
  binDir = mkdtempSync(join(tmpdir(), 'deploy-fly-service-fakebin-'));
  callsPath = join(binDir, 'calls.txt');
  writeFakeExecutable('docker', `echo "docker $*" >> "${callsPath}"`);
  writeFakeExecutable('flyctl', `echo "flyctl $*" >> "${callsPath}"`);
});

afterEach(() => {
  rmSync(binDir, { recursive: true, force: true });
});

function runScript(env: Record<string, string> = {}) {
  return spawnSync(SCRIPT, ['pagespace-web', 'ghcr.io/2witstudios/pagespace-web', 'sha-abc1234', '180'], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, ...env },
    encoding: 'utf-8',
  });
}

describe('deploy-fly-service.sh', () => {
  it('given no cutover snapshot, should retag the exact GHCR tag into Fly and deploy it without a config override', () => {
    const result = runScript();

    expect(result.status, result.stderr).toBe(0);
    const calls = readFileSync(callsPath, 'utf-8');
    expect(calls).toContain('docker pull ghcr.io/2witstudios/pagespace-web:sha-abc1234');
    expect(calls).toContain('docker tag ghcr.io/2witstudios/pagespace-web:sha-abc1234 registry.fly.io/pagespace-web:sha-abc1234');
    expect(calls).toContain('flyctl deploy --app pagespace-web --image registry.fly.io/pagespace-web:sha-abc1234 --wait-timeout 180');
    expect(calls).not.toContain('--config');
  });

  it('given a CUTOVER_DIR without a snapshot for this app, should deploy without a config override', () => {
    const cutoverDir = join(binDir, 'cutover');
    mkdirSync(cutoverDir);
    writeFileSync(join(cutoverDir, 'pagespace-realtime.toml'), 'app = "pagespace-realtime"\n');

    const result = runScript({ CUTOVER_DIR: cutoverDir });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(callsPath, 'utf-8')).not.toContain('--config');
  });

  it('given a billing-cutover snapshot config for this app, should deploy with that config', () => {
    const cutoverDir = join(binDir, 'cutover');
    mkdirSync(cutoverDir);
    writeFileSync(join(cutoverDir, 'pagespace-web.toml'), 'app = "pagespace-web"\n');

    const result = runScript({ CUTOVER_DIR: cutoverDir });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(callsPath, 'utf-8')).toContain(
      `flyctl deploy --config ${cutoverDir}/pagespace-web.toml --app pagespace-web --image registry.fly.io/pagespace-web:sha-abc1234`
    );
  });
});
