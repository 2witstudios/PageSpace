import { describe, expect, it, vi } from 'vitest';
import {
  FLAPS_TIMEOUT_MS,
  FlapsError,
  acquireLease,
  createApp,
  createDeployToken,
  createMachine,
  deleteApp,
  listMachineEvents,
  updateMachineConfig,
  waitForMachineState,
  waitRequestTimeoutMs,
  type FlapsTransport,
  type MachineConfig,
} from '../flaps-client';
import { assert } from './riteway';

const transport = (fetchImpl: typeof fetch): FlapsTransport => ({
  token: 'test-token',
  fetchImpl,
  // Keep retry-path tests from paying real backoff wall-clock time.
  sleep: async () => {},
});

/**
 * A transport that records the timeout each request was bounded by.
 *
 * `AbortSignal.timeout` exposes its duration nowhere, so the only other way to ask
 * "was this call bounded at 10s or at the 60s window it requested?" is to wait ten
 * real seconds and see whether it aborts.
 */
function timeoutRecordingTransport(fetchImpl: typeof fetch): {
  transport: FlapsTransport;
  timeouts: number[];
} {
  const timeouts: number[] = [];
  return {
    timeouts,
    transport: {
      ...transport(fetchImpl),
      abortSignalFor: (ms: number) => {
        timeouts.push(ms);
        return new AbortController().signal;
      },
    },
  };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** The parsed JSON body of the Nth call to a mocked fetch. */
function bodyOfCall(fetchImpl: ReturnType<typeof vi.fn>, index: number): unknown {
  const init = fetchImpl.mock.calls[index][1] as RequestInit;
  return JSON.parse(String(init.body));
}

/**
 * A realistic live machine config. `services`, `mounts` and `checks` are the
 * fields a full-replace update silently destroys, so they are what the merge tests
 * watch.
 */
const LIVE_CONFIG: MachineConfig = {
  image: 'registry.fly.io/pgs-app-abc:deployment-01',
  guest: { cpu_kind: 'shared', cpus: 1, memory_mb: 512 },
  services: [
    {
      protocol: 'tcp',
      internal_port: 8080,
      autostart: true,
      autostop: 'off',
      ports: [
        { port: 80, handlers: ['http'] },
        { port: 443, handlers: ['http', 'tls'] },
      ],
    },
  ],
  mounts: [{ volume: 'vol_123', path: '/data' }],
  checks: { alive: { type: 'tcp', port: 8080, interval: '15s', timeout: '2s' } },
  env: { PORT: '8080' },
};

describe('updateMachineConfig — the full-replace footgun', () => {
  it('given a merge that only touches guest.memory_mb, should POST a config that still carries services, mounts and checks', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/machines/m1')) {
        // The GET of the live machine, then the POST of the merged config.
        return json({ id: 'm1', state: 'started', config: LIVE_CONFIG });
      }
      return json({});
    });

    await updateMachineConfig(transport(fetchImpl as unknown as typeof fetch), 'pgs-app-abc', 'm1', (current) => ({
      ...current,
      guest: { ...current.guest, memory_mb: 1024 },
    }));

    // Call 0 is the GET; call 1 is the update.
    const sent = bodyOfCall(fetchImpl, 1) as { config: MachineConfig };

    // The change we asked for landed...
    expect(sent.config.guest?.memory_mb).toBe(1024);
    // ...and everything we did NOT name survived. A full-replace update that
    // dropped any of these would take the app offline with a 200 OK.
    expect(sent.config.services).toEqual(LIVE_CONFIG.services);
    expect(sent.config.mounts).toEqual(LIVE_CONFIG.mounts);
    expect(sent.config.checks).toEqual(LIVE_CONFIG.checks);
    expect(sent.config.image).toBe(LIVE_CONFIG.image);
    expect(sent.config.env).toEqual(LIVE_CONFIG.env);
  });

  it('given a live config with a field our types do not model, should round-trip it untouched', async () => {
    const withUnknown: MachineConfig = {
      ...LIVE_CONFIG,
      // A field Fly added that MachineConfig does not name. If the client
      // normalised through a closed type, this would vanish on the next update.
      dns: { nameservers: ['1.1.1.1'] },
      restart: { policy: 'always' },
    };
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ id: 'm1', config: withUnknown }));

    await updateMachineConfig(transport(fetchImpl as unknown as typeof fetch), 'pgs-app-abc', 'm1', (current) => ({
      ...current,
      image: 'registry.fly.io/pgs-app-abc:deployment-02',
    }));

    const sent = bodyOfCall(fetchImpl, 1) as { config: MachineConfig };
    expect(sent.config.dns).toEqual({ nameservers: ['1.1.1.1'] });
    expect(sent.config.restart).toEqual({ policy: 'always' });
    expect(sent.config.image).toBe('registry.fly.io/pgs-app-abc:deployment-02');
  });

  it('given the module surface, should expose no raw config setter that bypasses the merge', async () => {
    const mod = await import('../flaps-client');
    const setters = Object.keys(mod).filter(
      (name) => /^(set|replace|put)MachineConfig$/i.test(name),
    );
    expect(setters, 'a raw config setter re-opens the wipe footgun').toEqual([]);
  });

  it('given the live config, should hand the merge function the REAL current config, not an empty object', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ id: 'm1', config: LIVE_CONFIG }));
    let received: MachineConfig | null = null;

    await updateMachineConfig(transport(fetchImpl as unknown as typeof fetch), 'pgs-app-abc', 'm1', (current) => {
      received = current;
      return current;
    });

    expect(received).toEqual(LIVE_CONFIG);
  });
});

describe('createApp', () => {
  it('given a network, should send it verbatim on POST /v1/apps', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({}, 201));
    await createApp(transport(fetchImpl as unknown as typeof fetch), {
      appName: 'pgs-app-abc',
      orgSlug: 'pagespace',
      network: 'published-apps',
    });

    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://api.machines.dev/v1/apps');
    expect(bodyOfCall(fetchImpl, 0)).toEqual({
      app_name: 'pgs-app-abc',
      org_slug: 'pagespace',
      network: 'published-apps',
    });
  });

  it('given Fly reports the app already exists, should resolve as success — a retried provision must converge', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ error: 'App already exists' }, 422));
    await expect(
      createApp(transport(fetchImpl as unknown as typeof fetch), {
        appName: 'pgs-app-abc',
        orgSlug: 'pagespace',
        network: 'published-apps',
      }),
    ).resolves.toBeUndefined();
  });

  it('given a genuine failure, should reject rather than swallow it', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ error: 'unauthorized' }, 403));
    await expect(
      createApp(transport(fetchImpl as unknown as typeof fetch), {
        appName: 'pgs-app-abc',
        orgSlug: 'pagespace',
        network: 'published-apps',
      }),
    ).rejects.toBeInstanceOf(FlapsError);
  });
});

describe('deleteApp', () => {
  it('given the app is already gone (404), should resolve as success — the kill must be idempotent', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(null, { status: 404 }));
    await expect(
      deleteApp(transport(fetchImpl as unknown as typeof fetch), 'pgs-app-abc'),
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('given a persistent 500, should reject after the bounded retries rather than looping forever', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ error: 'internal' }, 500));
    await expect(
      deleteApp(transport(fetchImpl as unknown as typeof fetch), 'pgs-app-abc'),
    ).rejects.toBeInstanceOf(FlapsError);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe('rate limiting', () => {
  it('given a 429 with Retry-After, should wait the server-specified delay and then succeed', async () => {
    const slept: number[] = [];
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      call += 1;
      if (call === 1) return json({ error: 'rate limited' }, 429, { 'retry-after': '2' });
      return json({}, 200);
    });

    await createApp(
      {
        token: 't',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async (ms) => {
          slept.push(ms);
        },
      },
      { appName: 'pgs-app-abc', orgSlug: 'pagespace', network: 'published-apps' },
    );

    expect(slept).toEqual([2000]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('given a 403, should NOT retry — an auth failure is equally true next second', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ error: 'unauthorized' }, 403));
    await expect(
      deleteApp(transport(fetchImpl as unknown as typeof fetch), 'pgs-app-abc'),
    ).rejects.toBeInstanceOf(FlapsError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('createDeployToken', () => {
  it('given an expiry, should always send it as a body — Fly answers 400 EOF to a bodyless request', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ token: 'FlyV1 fm2_aaa,fm2_bbb' }));
    const token = await createDeployToken(
      transport(fetchImpl as unknown as typeof fetch),
      'pgs-app-abc',
      '48h',
    );

    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://api.machines.dev/v1/apps/pgs-app-abc/deploy_token',
    );
    expect(bodyOfCall(fetchImpl, 0)).toEqual({ expiry: '48h' });
    expect(token).toBe('FlyV1 fm2_aaa,fm2_bbb');
  });

  it('given a response with no token, should reject rather than return an empty credential', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({}));
    await expect(
      createDeployToken(transport(fetchImpl as unknown as typeof fetch), 'pgs-app-abc', '48h'),
    ).rejects.toBeInstanceOf(FlapsError);
  });
});

describe('listMachineEvents', () => {
  it('given Fly returns its capped event array, should pass it through raw and unfiltered', async () => {
    // Fly returns only the most recent 20 events — no pagination, no time window.
    const events = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, type: 'start' }));
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json(events));

    const actual = await listMachineEvents(
      transport(fetchImpl as unknown as typeof fetch),
      'pgs-app-abc',
      'm1',
    );
    expect(actual).toEqual(events);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://api.machines.dev/v1/apps/pgs-app-abc/machines/m1/events',
    );
  });

  assert({
    given: 'the events endpoint contract',
    should: 'be documented as last-20-only, since metering cannot be rebuilt from it',
    actual: /most recent 20|MOST RECENT 20/i.test(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').readFileSync(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('node:path').join(__dirname, '..', 'flaps-client.ts'),
        'utf8',
      ),
    ),
    expected: true,
  });
});

describe('waitForMachineState — the long poll must outlive the default timeout', () => {
  it('given a 60s wait, should bound the request by the wait window rather than the 10s default', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({}));
    const { transport: recording, timeouts } = timeoutRecordingTransport(
      fetchImpl as unknown as typeof fetch,
    );

    await waitForMachineState(recording, 'pgs-app-abc', 'm1', 'started', 60);

    // 10s would abort a healthy 60s long poll, retry it twice, and report a
    // transport failure for a machine that started fine.
    expect(timeouts).toEqual([waitRequestTimeoutMs(60)]);
    expect(timeouts[0]).toBeGreaterThan(60_000);
  });

  it('given a caller-supplied timeout, should scale the request bound with it', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({}));
    const { transport: recording, timeouts } = timeoutRecordingTransport(
      fetchImpl as unknown as typeof fetch,
    );

    await waitForMachineState(recording, 'pgs-app-abc', 'm1', 'started', 120);

    expect(timeouts).toEqual([120_000 + FLAPS_TIMEOUT_MS]);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('timeout=120');
  });

  it('given any other endpoint, should keep the 10s default so a hung socket cannot stall a worker', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({}, 201));
    const { transport: recording, timeouts } = timeoutRecordingTransport(
      fetchImpl as unknown as typeof fetch,
    );

    await createApp(recording, {
      appName: 'pgs-app-abc',
      orgSlug: 'pagespace',
      network: 'published-apps',
    });

    expect(timeouts).toEqual([FLAPS_TIMEOUT_MS]);
  });
});

describe('retry safety — an ambiguous failure must not double-create', () => {
  it('given a transport failure on a deploy-token mint, should NOT retry — a second mint is a second live credential', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      throw new Error('socket hang up');
    });

    await expect(
      createDeployToken(transport(fetchImpl as unknown as typeof fetch), 'pgs-app-abc', '48h'),
    ).rejects.toBeInstanceOf(FlapsError);
    // The request may well have landed; retrying it mints another token that is
    // returned to nobody and recorded nowhere.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('given a 500 on a deploy-token mint, should NOT retry — Fly may have minted before failing to answer', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({ error: 'internal' }, 500));

    await expect(
      createDeployToken(transport(fetchImpl as unknown as typeof fetch), 'pgs-app-abc', '48h'),
    ).rejects.toBeInstanceOf(FlapsError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('given a 429 on a deploy-token mint, should retry — a rate limit is the one failure Fly says it did not process', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      call += 1;
      if (call === 1) return json({ error: 'rate limited' }, 429, { 'retry-after': '1' });
      return json({ token: 'FlyV1 fm2_aaa' });
    });

    const token = await createDeployToken(
      transport(fetchImpl as unknown as typeof fetch),
      'pgs-app-abc',
      '48h',
    );
    expect(token).toBe('FlyV1 fm2_aaa');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('given a transport failure on an UNNAMED machine create, should NOT retry — every send bills another machine', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      throw new Error('socket hang up');
    });

    await expect(
      createMachine(transport(fetchImpl as unknown as typeof fetch), {
        appName: 'pgs-app-abc',
        config: { image: 'registry.fly.io/pgs-app-abc:deployment-01' },
      }),
    ).rejects.toBeInstanceOf(FlapsError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('given a transport failure on a NAMED machine create, should retry — the name is the idempotency key', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      call += 1;
      if (call === 1) throw new Error('socket hang up');
      return json({ id: 'm1', name: 'pgs-app-abc-01' });
    });

    const machine = await createMachine(transport(fetchImpl as unknown as typeof fetch), {
      appName: 'pgs-app-abc',
      name: 'pgs-app-abc-01',
      config: { image: 'registry.fly.io/pgs-app-abc:deployment-01' },
    });

    expect(machine.id).toBe('m1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('given a named create whose first attempt already landed, should resolve by lookup rather than create a second machine', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(url)}`);
      if (init?.method === 'POST') return json({ error: 'already_exists: machine name' }, 409);
      // The list, resolving the machine the lost attempt created.
      return json([
        { id: 'other', name: 'pgs-app-abc-99' },
        { id: 'm1', name: 'pgs-app-abc-01' },
      ]);
    });

    const machine = await createMachine(transport(fetchImpl as unknown as typeof fetch), {
      appName: 'pgs-app-abc',
      name: 'pgs-app-abc-01',
      config: { image: 'registry.fly.io/pgs-app-abc:deployment-01' },
    });

    expect(machine.id).toBe('m1');
    // Exactly one POST: the conflict is resolved by reading, never by creating again.
    expect(calls.filter((c) => c.startsWith('POST'))).toHaveLength(1);
  });

  it('given a transport failure on a lease acquire, should NOT retry — the nonce of a lost response is unrecoverable', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      throw new Error('socket hang up');
    });

    await expect(
      acquireLease(transport(fetchImpl as unknown as typeof fetch), 'pgs-app-abc', 'm1'),
    ).rejects.toBeInstanceOf(FlapsError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('given a transport failure on an app create, should retry — the app name makes it idempotent by key', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      call += 1;
      if (call === 1) throw new Error('socket hang up');
      return json({}, 201);
    });

    await createApp(transport(fetchImpl as unknown as typeof fetch), {
      appName: 'pgs-app-abc',
      orgSlug: 'pagespace',
      network: 'published-apps',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('auth', () => {
  it('given a token, should send it as a Bearer header on every call', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => json({}));
    await deleteApp(transport(fetchImpl as unknown as typeof fetch), 'pgs-app-abc');
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });
});
