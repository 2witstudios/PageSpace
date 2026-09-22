/**
 * The worker against the real thing: a real Chromium (Playwright's build,
 * over its debugging pipe), the real egress proxy on a loopback socket, and
 * real HTTP requests carrying real Ed25519-signed instructions.
 *
 * The test web server is on loopback, which the navigation rules refuse by
 * design. So the suite gives the proxy a resolver that answers a public
 * address for `*.form.test` and a dialer that connects that address to the
 * loopback server. The decision itself is not touched: `127.0.0.1` and
 * private addresses are still refused, and that is asserted below.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert } from './riteway.js';
import { createTestSigner } from './support/control-signer.js';
import { startBrowserControlWorker, type BrowserControlWorker } from '../browser-control-worker.js';
import { startBrowserEgressProxy } from '../browser-egress-proxy-adapter.js';
import type { ControlActor, ControlCommand } from '../control-instruction.js';
import type { BrowserControlResponse, BrowserOperation } from '../browser-operation.js';

const SESSION = 'bws_integration_1';
const FAKE_PUBLIC = '93.184.216.34';
const AGENT: ControlActor = { kind: 'agent', agentId: 'agent-page-1' };
const ALICE: ControlActor = { kind: 'human', userId: 'user-alice' };

const signer = createTestSigner();
const submissions: string[] = [];
let site: Server;
let sitePort = 0;
let worker: BrowserControlWorker;
let profileRoot: string;

const FORM_PAGE = `<!doctype html><html><head><title>Contact us</title></head><body>
<h1>Contact us</h1>
<form method="post" action="/submit">
  <label for="name">Your name</label><input id="name" name="name">
  <button type="submit">Send</button>
</form>
<img src="http://10.0.0.1/tracker.png" alt="">
</body></html>`;

const startSite = (): Promise<void> =>
  new Promise((done) => {
    site = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/submit') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          submissions.push(body);
          res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Thanks</title><p>Thanks!</p>');
        });
        return;
      }
      if (req.url === '/stall') {
        setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Stalled</title>'), 8_000);
        return;
      }
      if (req.url === '/slow') {
        setTimeout(() => res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>Slow</title><p>slow</p>'), 1_500);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' }).end(FORM_PAGE);
    });
    site.listen(0, '127.0.0.1', () => {
      sitePort = (site.address() as AddressInfo).port;
      done();
    });
  });

const post = async (instruction: string | null): Promise<{ status: number; body: unknown }> => {
  const response = await fetch(`${worker.url}/control`, {
    method: 'POST',
    body: instruction ?? '',
  });
  return { status: response.status, body: await response.json() };
};

const command = (actor: ControlActor, cmd: ControlCommand, sid = SESSION) => post(signer.instruct({ sid, actor, command: cmd }));
const agentOp = async (operation: BrowserOperation): Promise<BrowserControlResponse> => (await command(AGENT, { type: 'operation', operation })).body as BrowserControlResponse;

const refOf = (snapshot: string, label: RegExp): string => {
  const line = snapshot.split('\n').find((l) => label.test(l)) ?? '';
  return /\[ref=([A-Za-z0-9]+)\]/.exec(line)?.[1] ?? 'missing';
};

beforeAll(async () => {
  await startSite();
  profileRoot = await mkdtemp(join(tmpdir(), 'bw-it-'));
  worker = await startBrowserControlWorker({
    sessionId: SESSION,
    controlPublicKey: signer.publicKey,
    allowedOrigins: null,
    listen: { host: '127.0.0.1', port: 0 },
    profileRoot,
    egress: {
      resolve: async (host) => (host.endsWith('form.test') ? [FAKE_PUBLIC] : host === 'rebind.form-attack.test' ? [FAKE_PUBLIC, '127.0.0.1'] : []),
      dial: (address, port) => (address === FAKE_PUBLIC ? connect({ host: '127.0.0.1', port: sitePort }) : connect({ host: address, port })),
    },
  });
});

afterAll(async () => {
  await worker?.close();
  await new Promise((done) => site?.close(done));
  await rm(profileRoot, { recursive: true, force: true });
});

describe('browser control worker (real Chromium)', () => {
  it('drives Chromium over a pipe: no debugging port, a private per-context profile', async () => {
    const psOut = execFileSync('ps', ['-axww', '-o', 'pid=,command=']).toString();
    const browserLines = psOut.split('\n').filter((line) => line.includes(profileRoot) && line.includes('--user-data-dir'));
    const pids = browserLines.map((line) => line.trim().split(/\s+/)[0]);
    const listening = pids.length === 0 ? '' : (() => {
      try {
        return execFileSync('lsof', ['-a', '-nP', '-iTCP', '-sTCP:LISTEN', '-p', pids.join(',')]).toString();
      } catch {
        return '';
      }
    })();
    const contexts = await readdir(profileRoot);
    const profileMode = (await stat(join(profileRoot, contexts[0]))).mode & 0o777;
    assert({
      given: 'a running session',
      should: 'show a browser launched with --remote-debugging-pipe, no --remote-debugging-port, no listening TCP socket, and a 0700 profile',
      actual: {
        browserFound: browserLines.length > 0,
        pipe: browserLines.some((l) => l.includes('--remote-debugging-pipe')),
        port: browserLines.some((l) => l.includes('--remote-debugging-port')),
        listening: listening.trim(),
        contexts: contexts.length,
        profileMode: profileMode.toString(8),
      },
      expected: { browserFound: true, pipe: true, port: false, listening: '', contexts: 1, profileMode: '700' },
    });
  });

  it('refuses every request that is not a signed instruction for this session', async () => {
    const stranger = createTestSigner();
    const results = await Promise.all([
      post(null),
      post('garbage'),
      post(stranger.instruct({ sid: SESSION, actor: AGENT, command: { type: 'operation', operation: { kind: 'read' } } })),
      command(AGENT, { type: 'operation', operation: { kind: 'read' } }, 'bws_other_session'),
    ]);
    assert({
      given: 'no instruction, a garbage one, one signed by another key, and one for another session',
      should: 'answer 401 with the reason, before touching the browser',
      actual: results.map((r) => [r.status, (r.body as { error: string }).error]),
      expected: [
        [401, 'malformed'],
        [401, 'malformed'],
        [401, 'bad-signature'],
        [401, 'wrong-session'],
      ],
    });
  });

  it('refuses a replayed instruction', async () => {
    const once = signer.instruct({ sid: SESSION, actor: AGENT, command: { type: 'operation', operation: { kind: 'tabs', action: 'list' } } });
    const first = await post(once);
    const second = await post(once);
    assert({
      given: 'the same signed instruction sent twice',
      should: 'run it once and refuse the replay',
      actual: [first.status, second.status, (second.body as { error: string }).error],
      expected: [200, 401, 'replayed'],
    });
  });

  it('fills and submits a public form through typed operations only', async () => {
    const navigated = await agentOp({ kind: 'navigate', url: 'http://www.form.test/contact' });
    const read = await agentOp({ kind: 'read' });
    const snapshot = read.ok && read.result.kind === 'read' ? read.result.snapshot : '';
    const typed = await agentOp({ kind: 'type', ref: refOf(snapshot, /textbox "Your name"/), text: 'Ada Lovelace', submit: false });
    const clicked = await agentOp({ kind: 'click', ref: refOf(snapshot, /button "Send"/) });
    assert({
      given: 'navigate, read, type and click on a contact form',
      should: 'land on the form, submit the typed value, and reach the thank-you page',
      actual: {
        navigated: navigated.ok && navigated.result.kind === 'navigate' ? navigated.result.page.title : navigated,
        typed: typed.ok,
        clicked: clicked.ok && clicked.result.kind === 'click' ? clicked.result.page.title : clicked,
        submissions: [...submissions],
      },
      expected: { navigated: 'Contact us', typed: true, clicked: 'Thanks', submissions: ['name=Ada+Lovelace'] },
    });
  });

  it('refused the page subresource on a private address at the proxy', async () => {
    expect(worker.audit().egressRefusals).toBeGreaterThan(0);
  });

  it('refuses loopback, private and rebinding targets with a typed refusal', async () => {
    const targets = ['http://127.0.0.1:1/', 'http://localhost/', 'https://agent-x.sprites.app/', 'http://rebind.form-attack.test/'];
    const results = await Promise.all(targets.map((url) => agentOp({ kind: 'navigate', url })));
    assert({
      given: 'navigations to loopback, a loopback name, another sandbox and a rebinding host',
      should: 'refuse each as a navigation the policy denies',
      actual: results.map((r) => (r.ok ? 'allowed' : r.refusal.reason)),
      expected: ['navigation-denied', 'navigation-denied', 'navigation-denied', 'navigation-denied'],
    });
  });

  it('cuts the agent off completely in human-control mode and restarts the browser on release', async () => {
    await agentOp({ kind: 'navigate', url: 'http://www.form.test/contact' });
    const before = worker.audit();

    const slow = agentOp({ kind: 'navigate', url: 'http://www.form.test/slow' });
    await new Promise((done) => setTimeout(done, 200));
    const takeOver = await command(ALICE, { type: 'take-over' });
    const inFlight = await slow;

    const duringHuman: BrowserControlResponse[] = [];
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      duringHuman.push(await agentOp({ kind: 'read' }), await agentOp({ kind: 'screenshot' }), await agentOp({ kind: 'tabs', action: 'list' }));
    }
    const frame = await command(ALICE, { type: 'view-frame' });
    const humanTyped = await command(ALICE, { type: 'human-input', input: { kind: 'key', key: 'Tab' } });
    const agentTakeOver = await command(AGENT, { type: 'take-over' });
    const bobRelease = await command({ kind: 'human', userId: 'user-bob' }, { type: 'release' });
    const during = worker.audit();

    const release = await command(ALICE, { type: 'release' });
    const afterTabs = await agentOp({ kind: 'tabs', action: 'list' });

    assert({
      given: 'a slow agent navigation in flight, a take-over by Alice, 3 s of agent reads, screenshots and tab lists, then Alice releasing',
      should: 'withhold the in-flight result, refuse every agent request, let only Alice view and type, release nothing to the agent, and hand back a fresh browser',
      actual: {
        takeOver: [takeOver.status, (takeOver.body as { mode: string }).mode],
        inFlight: inFlight.ok ? 'released' : inFlight.refusal.reason,
        everyAgentRequestRefused: duringHuman.every((r) => !r.ok && r.refusal.reason === 'human-control'),
        agentRequests: duringHuman.length > 3,
        frame: [frame.status, typeof (frame.body as { image?: { base64?: string } }).image?.base64],
        humanTyped: humanTyped.status,
        agentTakeOver: agentTakeOver.status,
        bobRelease: [bobRelease.status, (bobRelease.body as { rejected: string }).rejected],
        releasedDuringCut: during.agentResultsReleasedOutsideAgentControl,
        releasedWhileHuman: during.agentResultsReleased - before.agentResultsReleased,
        release: [release.status, (release.body as { mode: string }).mode],
        freshContext: afterTabs.ok && afterTabs.result.kind === 'tabs' ? afterTabs.result.tabs.map((t) => t.url) : afterTabs,
        restarts: worker.audit().browserRestarts,
        profiles: (await readdir(profileRoot)).length,
      },
      expected: {
        takeOver: [200, 'human-control'],
        inFlight: 'observation-suppressed',
        everyAgentRequestRefused: true,
        agentRequests: true,
        frame: [200, 'string'],
        humanTyped: 200,
        agentTakeOver: 401,
        bobRelease: [409, 'not-holder'],
        releasedDuringCut: 0,
        releasedWhileHuman: 0,
        release: [200, 'agent-control'],
        freshContext: ['about:blank'],
        restarts: 1,
        profiles: 1,
      },
    });
  });

  it('accepts the largest typed text, even when it is not ASCII', async () => {
    await agentOp({ kind: 'navigate', url: 'http://www.form.test/contact' });
    const read = await agentOp({ kind: 'read' });
    const snapshot = read.ok && read.result.kind === 'read' ? read.result.snapshot : '';
    const typed = await agentOp({ kind: 'type', ref: refOf(snapshot, /textbox "Your name"/), text: 'é'.repeat(10_000), submit: false });
    assert({
      given: '10,000 two-byte characters typed into a field',
      should: 'reach the worker and succeed (the instruction travels in the body, not a header)',
      actual: typed.ok,
      expected: true,
    });
  });
});

describe('a page that will not answer', () => {
  it('restarts the browser at the operation deadline, so a take-over is never held hostage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bw-deadline-'));
    const stuck = await startBrowserControlWorker({
      sessionId: 'bws_deadline',
      controlPublicKey: signer.publicKey,
      allowedOrigins: null,
      listen: { host: '127.0.0.1', port: 0 },
      profileRoot: root,
      operationDeadlineMs: 2_000,
      egress: {
        resolve: async () => [FAKE_PUBLIC],
        dial: (_address, _port) => connect({ host: '127.0.0.1', port: sitePort }),
      },
    });
    const send = async (actor: ControlActor, cmd: ControlCommand) => {
      const response = await fetch(`${stuck.url}/control`, { method: 'POST', body: signer.instruct({ sid: 'bws_deadline', actor, command: cmd }) });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const started = Date.now();
    const navigation = send(AGENT, { type: 'operation', operation: { kind: 'navigate', url: 'http://www.form.test/stall' } });
    await new Promise((done) => setTimeout(done, 300));
    const takeOver = await send(ALICE, { type: 'take-over' });
    const tookMs = Date.now() - started;
    const navigated = (await navigation).body as unknown as BrowserControlResponse;
    const audit = stuck.audit();
    await stuck.close();
    await rm(root, { recursive: true, force: true });
    assert({
      given: 'an agent navigation to a page that answers after 8 s, a 2 s deadline, and a take-over 0.3 s in',
      should: 'give the human control within the deadline plus a restart, withhold the navigation, and restart once',
      actual: {
        takeOver: [takeOver.status, takeOver.body.mode],
        inTime: tookMs < 7_000,
        navigated: navigated.ok ? 'released' : navigated.refusal.reason,
        restarts: audit.browserRestarts,
        releasedOutside: audit.agentResultsReleasedOutsideAgentControl,
      },
      expected: { takeOver: [200, 'human-control'], inTime: true, navigated: 'observation-suppressed', restarts: 1, releasedOutside: 0 },
    });
  });
});

describe('egress proxy resilience', () => {
  it('survives a client that resets its CONNECT socket mid-lookup', async () => {
    const proxy = await startBrowserEgressProxy({
      allowedOrigins: null,
      resolve: (host) => new Promise((done) => setTimeout(() => done(host === 'slow.form.test' ? [FAKE_PUBLIC] : []), 400)),
      dial: () => connect({ host: '127.0.0.1', port: sitePort }),
    });
    const port = Number(new URL(proxy.url).port);
    await new Promise<void>((done) => {
      const socket = connect({ host: '127.0.0.1', port }, () => {
        socket.write('CONNECT slow.form.test:443 HTTP/1.1\r\nHost: slow.form.test:443\r\n\r\n');
        setTimeout(() => {
          socket.resetAndDestroy();
          done();
        }, 50);
      });
    });
    await new Promise((done) => setTimeout(done, 800));
    const stillAnswers = await new Promise<string>((done) => {
      const probe = connect({ host: '127.0.0.1', port }, () => probe.write('CONNECT 10.0.0.1:443 HTTP/1.1\r\n\r\n'));
      probe.once('data', (data) => {
        done(data.toString().split('\r\n')[0]);
        probe.destroy();
      });
    });
    await proxy.close();
    assert({
      given: 'a CONNECT whose client resets during the lookup, then a CONNECT to a private address',
      should: 'stay up and refuse the second',
      actual: stillAnswers,
      expected: 'HTTP/1.1 403 Forbidden',
    });
  });
});
