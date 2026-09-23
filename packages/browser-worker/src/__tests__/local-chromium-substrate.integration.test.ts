/**
 * The local substrate against real workers: the in-process launch drives the
 * adapter's own lifecycle (idempotent provision, find, send, destroy) with a
 * real worker and Chromium; the spawn test runs the BUILT entry point as a
 * separate process, so it needs `dist/` (CI builds it before tests).
 */
import { describe, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from './riteway.js';
import { createTestSigner } from './support/control-signer.js';
import { createLocalChromiumSubstrate } from '../local-chromium-substrate-adapter.js';
import { startBrowserControlWorker } from '../browser-control-worker.js';
import type { BrowserSubstrate } from '../browser-substrate.js';

const signer = createTestSigner();
const DIST_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'standalone-browser-worker.js');

const listTabs = async (substrate: BrowserSubstrate, sessionId: string) => {
  const session = await substrate.find(sessionId);
  if (session === null) return null;
  const instruction = signer.instruct({ sid: sessionId, actor: { kind: 'agent', agentId: 'a1' }, command: { type: 'operation', operation: { kind: 'tabs', action: 'list' } } });
  const response = await session.send({ method: 'POST', path: '/control', headers: {}, body: instruction });
  return { status: response.status, ok: (JSON.parse(response.body) as { ok: boolean }).ok };
};

describe('local chromium substrate', () => {
  it('provisions once per session, reaches the worker through send, and removes it on destroy', async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), 'bw-local-'));
    let launches = 0;
    const substrate = createLocalChromiumSubstrate({
      launch: async (spec) => {
        launches += 1;
        const worker = await startBrowserControlWorker({ ...spec, listen: { host: '127.0.0.1', port: 0 }, profileRoot });
        return { url: worker.url, stop: worker.close };
      },
    });
    const spec = { sessionId: 'bws_local_1', controlPublicKey: signer.publicKey, allowedOrigins: null };
    const [a, b] = await Promise.all([substrate.provision(spec), substrate.provision(spec)]);
    const tabs = await listTabs(substrate, spec.sessionId);
    const profilesWhileLive = (await readdir(profileRoot)).length;
    await substrate.destroy(spec.sessionId);
    const afterDestroy = { found: await substrate.find(spec.sessionId), profiles: (await readdir(profileRoot)).length };
    await rm(profileRoot, { recursive: true, force: true });
    assert({
      given: 'two concurrent provisions of one session, a tab listing, then destroy',
      should: 'start one worker, answer through send, and leave no session and no profile behind',
      actual: { launches, same: a.sessionId === b.sessionId, substrate: a.substrate, tabs, profilesWhileLive, afterDestroy },
      expected: { launches: 1, same: true, substrate: 'local', tabs: { status: 200, ok: true }, profilesWhileLive: 1, afterDestroy: { found: null, profiles: 0 } },
    });
  });

  it.skipIf(!existsSync(DIST_ENTRY))('spawns the built worker as its own process with a minimal environment', async () => {
    process.env.PAGESPACE_TEST_SERVER_SECRET = 'must-not-leak';
    const substrate = createLocalChromiumSubstrate({ entryPath: DIST_ENTRY });
    const spec = { sessionId: 'bws_local_spawn', controlPublicKey: signer.publicKey, allowedOrigins: null };
    await substrate.provision(spec);
    const tabs = await listTabs(substrate, spec.sessionId);
    await substrate.destroy(spec.sessionId);
    delete process.env.PAGESPACE_TEST_SERVER_SECRET;
    assert({
      given: 'the built entry point',
      should: 'start, obey a signed instruction, and stop',
      actual: { tabs, afterDestroy: await substrate.find(spec.sessionId) },
      expected: { tabs: { status: 200, ok: true }, afterDestroy: null },
    });
  });
});

describe('worker idle expiry', () => {
  it('closes the browser and deletes the profile when nobody instructs it', async () => {
    const profileRoot = await mkdtemp(join(tmpdir(), 'bw-expiry-'));
    let expired = false;
    const worker = await startBrowserControlWorker({
      sessionId: 'bws_expiry',
      controlPublicKey: signer.publicKey,
      allowedOrigins: null,
      listen: { host: '127.0.0.1', port: 0 },
      profileRoot,
      idleShutdownMs: 1_500,
      onExpire: () => {
        expired = true;
      },
    });
    const before = (await readdir(profileRoot)).length;
    await new Promise((done) => setTimeout(done, 4_000));
    const reachable = await fetch(`${worker.url}/healthz`).then(() => true, () => false);
    const after = (await readdir(profileRoot)).length;
    await rm(profileRoot, { recursive: true, force: true });
    assert({
      given: 'a worker with a 1.5 s idle limit that receives no instruction',
      should: 'expire on its own: profile deleted, port closed, onExpire called',
      actual: { before, after, reachable, expired },
      expected: { before: 1, after: 0, reachable: false, expired: true },
    });
  });
});
