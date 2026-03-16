/**
 * Integration tests for Docker image runtime environment verification.
 *
 * These tests spin up containers from built images, pass runtime-only env vars,
 * and assert that health endpoints respond correctly.
 *
 * Prerequisites:
 *   - Docker must be running
 *   - Images must be built locally or pulled from GHCR first:
 *       docker compose build  (or pull from registry)
 *
 * Run with:
 *   cd infrastructure && npx vitest run scripts/__tests__/image-runtime.test.ts --timeout 120000
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execSync, ExecSyncOptions } from 'child_process';
import { resolve } from 'path';
import { readFileSync } from 'fs';

const COMPOSE_FILE = resolve(__dirname, '../../docker-compose.test.yml');
const PROJECT_NAME = `ps-image-test-${Date.now()}`;
const EXEC_OPTS: ExecSyncOptions = { stdio: 'pipe', timeout: 120_000 };

function run(cmd: string): string {
  return execSync(cmd, EXEC_OPTS).toString().trim();
}

function composeCmd(subcommand: string): string {
  return `docker compose -p ${PROJECT_NAME} -f ${COMPOSE_FILE} ${subcommand}`;
}

function waitForHealthy(service: string, maxWaitSec = 60): void {
  const deadline = Date.now() + maxWaitSec * 1000;
  while (Date.now() < deadline) {
    try {
      const health = run(
        composeCmd(`ps --format json ${service}`),
      );
      // docker compose ps --format json may return one JSON object per line
      const lines = health.split('\n').filter(Boolean);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        if (parsed.Health === 'healthy' || parsed.State === 'running') {
          return;
        }
      }
    } catch {
      // container not ready yet
    }
    execSync('sleep 2', { stdio: 'ignore' });
  }
  throw new Error(`Service ${service} did not become healthy within ${maxWaitSec}s`);
}

function cleanup(): void {
  try {
    execSync(composeCmd('down -v --remove-orphans'), { stdio: 'ignore', timeout: 30_000 });
  } catch {
    // best-effort cleanup
  }
}

// Only run if the compose file exists (it won't on CI unless explicitly set up)
const composeFileExists = (() => {
  try {
    readFileSync(COMPOSE_FILE);
    return true;
  } catch {
    return false;
  }
})();

const dockerAvailable = (() => {
  try {
    execSync('docker info', { stdio: 'ignore', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
})();

const canRun = composeFileExists && dockerAvailable;

describe.skipIf(!canRun)('Image runtime env verification', () => {
  afterAll(() => {
    cleanup();
  });

  it('should start processor with runtime env vars and pass health check', () => {
    cleanup();
    run(composeCmd('up -d processor-test'));
    waitForHealthy('processor-test', 60);

    const response = run(`docker compose -p ${PROJECT_NAME} -f ${COMPOSE_FILE} exec processor-test node -e "require('http').get('http://localhost:3003/health', (r) => { let d=''; r.on('data', c => d+=c); r.on('end', () => { console.log(r.statusCode); process.exit(r.statusCode === 200 ? 0 : 1); }); })"`);
    expect(response).toContain('200');
  }, 90_000);

  it('should start web with runtime env vars without crashing', () => {
    run(composeCmd('up -d web-test'));

    // Web needs postgres - check that container stays running for 10s
    const deadline = Date.now() + 15_000;
    let lastState = '';
    while (Date.now() < deadline) {
      try {
        const output = run(composeCmd('ps --format json web-test'));
        const lines = output.split('\n').filter(Boolean);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          lastState = parsed.State;
          if (parsed.State === 'exited') {
            throw new Error('web-test exited prematurely');
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('exited prematurely')) throw e;
      }
      execSync('sleep 2', { stdio: 'ignore' });
    }
    // If we get here, the container stayed running
    expect(lastState).toBe('running');
  }, 30_000);

  it('should start realtime with runtime env vars without crashing', () => {
    run(composeCmd('up -d realtime-test'));

    const deadline = Date.now() + 15_000;
    let lastState = '';
    while (Date.now() < deadline) {
      try {
        const output = run(composeCmd('ps --format json realtime-test'));
        const lines = output.split('\n').filter(Boolean);
        for (const line of lines) {
          const parsed = JSON.parse(line);
          lastState = parsed.State;
          if (parsed.State === 'exited') {
            throw new Error('realtime-test exited prematurely');
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('exited prematurely')) throw e;
      }
      execSync('sleep 2', { stdio: 'ignore' });
    }
    expect(lastState).toBe('running');
  }, 30_000);

  it('should fail with clear error when container cannot start', () => {
    // This test validates that the waitForHealthy helper properly times out
    expect(() => waitForHealthy('nonexistent-service', 3)).toThrow(
      /did not become healthy within 3s/,
    );
  }, 10_000);
});
