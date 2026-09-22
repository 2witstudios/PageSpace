/**
 * The session client against a real local substrate (real workers, real
 * Chromium). The meter is a recording fake: it is a port the web app binds
 * to the credit ledger, and what matters here is when and with what this
 * client calls it.
 */
import { afterAll, describe, it } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert } from './riteway.js';
import { createBrowserSessionClient, type BrowserMeter } from '../browser-session-client.js';
import { createLocalChromiumSubstrate } from '../local-chromium-substrate-adapter.js';
import { startBrowserControlWorker } from '../browser-control-worker.js';
import type { BrowserSessionSpec } from '../browser-substrate.js';

type Billing = { readonly payerId: string };

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const controlPublicKey = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const sign = (message: Uint8Array): Uint8Array => new Uint8Array(nodeSign(null, message, privateKey));

const roots: string[] = [];
afterAll(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

const setup = async (options: { readonly refuse?: boolean } = {}) => {
  const profileRoot = await mkdtemp(join(tmpdir(), 'bw-client-'));
  roots.push(profileRoot);
  const launched: string[] = [];
  const meterCalls: unknown[] = [];
  // Starts at the real time: the workers verify instruction windows against their own clock.
  let now = Date.now();
  const substrate = createLocalChromiumSubstrate({
    shape: { cpus: 2, memoryGB: 2 },
    clock: () => now,
    launch: async (spec: BrowserSessionSpec) => {
      launched.push(spec.sessionId);
      const worker = await startBrowserControlWorker({ ...spec, listen: { host: '127.0.0.1', port: 0 }, profileRoot });
      return { url: worker.url, stop: worker.close };
    },
  });
  const meter: BrowserMeter<Billing> = {
    open: async (billing) => {
      meterCalls.push(['open', billing.payerId]);
      return options.refuse === true ? { ok: false, reason: 'Out of credits.' } : { ok: true, hold: { holdId: `hold-${billing.payerId}` } };
    },
    close: async ({ billing, hold, activeSeconds, shape, substrate: label }) => {
      meterCalls.push(['close', billing.payerId, hold.holdId, activeSeconds, shape, label]);
    },
  };
  const client = createBrowserSessionClient<Billing>({ substrate, controlPublicKey, sign, meter, clock: () => now, idleTimeoutMs: 60_000 });
  return { client, launched, meterCalls, advance: (ms: number) => (now += ms) };
};

const ref = (sessionId: string) => ({ sessionId, allowedOrigins: null, billing: { payerId: 'payer-1' } });

describe('browser session client', () => {
  it('holds before provisioning, provisions once, and settles the lifetime at the real shape', async () => {
    const { client, launched, meterCalls, advance } = await setup();
    const [first, second] = await Promise.all([
      client.operate({ session: ref('bws_client_1'), agentId: 'agent-1', operation: { kind: 'tabs', action: 'list' } }),
      client.operate({ session: ref('bws_client_1'), agentId: 'agent-1', operation: { kind: 'tabs', action: 'list' } }),
    ]);
    advance(90_000);
    await client.end('bws_client_1');
    assert({
      given: 'two concurrent operations on a new session, 90 s, then end',
      should: 'hold once, start one worker, answer both, and settle 90 s at 2 vCPU / 2 GB on the local substrate',
      actual: { ok: [first.ok, second.ok], launched, meterCalls },
      expected: {
        ok: [true, true],
        launched: ['bws_client_1'],
        meterCalls: [
          ['open', 'payer-1'],
          ['close', 'payer-1', 'hold-payer-1', 90, { cpus: 2, memoryGB: 2 }, 'local'],
        ],
      },
    });
  });

  it('refuses the session, and starts nothing, when the payer cannot be held', async () => {
    const { client, launched, meterCalls } = await setup({ refuse: true });
    const response = await client.operate({ session: ref('bws_client_2'), agentId: 'agent-1', operation: { kind: 'read' } });
    assert({
      given: 'a meter that refuses the hold',
      should: 'answer billing-denied without provisioning a browser',
      actual: { response, launched, meterCalls },
      expected: { response: { ok: false, refusal: { reason: 'billing-denied', detail: 'Out of credits.' } }, launched: [], meterCalls: [['open', 'payer-1']] },
    });
  });

  it('lets the human take the session and cuts the agent off, then destroys idle sessions', async () => {
    const { client, advance, meterCalls } = await setup();
    await client.operate({ session: ref('bws_client_3'), agentId: 'agent-1', operation: { kind: 'tabs', action: 'list' } });
    const takeOver = await client.human({ sessionId: 'bws_client_3', userId: 'user-1', command: { type: 'take-over' } });
    const agentDuring = await client.operate({ session: ref('bws_client_3'), agentId: 'agent-1', operation: { kind: 'read' } });
    const noSession = await client.human({ sessionId: 'bws_client_missing', userId: 'user-1', command: { type: 'view-frame' } });
    advance(61_000);
    const swept = await client.sweepIdle();
    assert({
      given: 'a live session, a human take-over, an agent read, a pane request for no session, then 61 s idle',
      should: 'hand control to the human, refuse the agent, 404 the missing pane, and destroy and settle the idle session',
      actual: {
        takeOver: takeOver.status,
        agentDuring: agentDuring.ok ? 'released' : agentDuring.refusal.reason,
        noSession: noSession.status,
        swept,
        settled: meterCalls.filter((call) => (call as unknown[])[0] === 'close').length,
      },
      expected: { takeOver: 200, agentDuring: 'human-control', noSession: 404, swept: ['bws_client_3'], settled: 1 },
    });
  });
});
