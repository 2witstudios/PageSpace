/**
 * The production `BridgeTransport` (M1 · t09).
 *
 * The behavioural assertions here are small. The one that matters most is the
 * SOURCE assertion at the bottom: this module must remain a wrapper over
 * t07's `EnvBridgeClient.sendGrant`, because that is where grant signing,
 * correlation and machine-signature verification live — once each. Two
 * verification paths cannot be caught by behaviour (both pass their own tests
 * right up until one stops rejecting something), so it is pinned by reading
 * the file, in the same spirit as t08's `invariants.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const sendGrant = vi.fn(async () => ({ type: 'exec_result' as const, grantId: 'g1', exitCode: 0, stdoutB64: '', stderrB64: '', truncated: false, sig: 's' }));
vi.mock('@/lib/env-bridge/bridge-client', () => ({ getEnvBridgeClient: () => ({ sendGrant }) }));

const getAuthorizedEnvConnection = vi.fn<(envId: string) => object | undefined>(() => undefined);
const getEnvConnectionMetadata = vi.fn<(ws: object) => { sessionId: string; connectedAt: Date } | undefined>(() => undefined);
vi.mock('@/lib/websocket/ws-env-connections', () => ({
  getAuthorizedEnvConnection: (envId: string) => getAuthorizedEnvConnection(envId),
  getEnvConnectionMetadata: (ws: object) => getEnvConnectionMetadata(ws),
}));

import { createLocalEnvTransport, LocalEnvNoPrincipalError } from '../local-env-transport';

const ENV_ID = 'env-1';
const PRINCIPAL = { userId: 'u1', sessionId: 'ws1', conversationId: 'c1' };
const FRAME = { type: 'grant_exec' as const, cmd: 'ls' };

beforeEach(() => {
  vi.clearAllMocks();
  getAuthorizedEnvConnection.mockReturnValue(undefined);
  getEnvConnectionMetadata.mockReturnValue(undefined);
});

describe('createLocalEnvTransport', () => {
  it('should delegate every send to the ONE bridge client, carrying the acting principal', async () => {
    const transport = createLocalEnvTransport({ principal: PRINCIPAL });
    await transport.sendGrant({ envId: ENV_ID, frame: FRAME });

    expect(sendGrant).toHaveBeenCalledWith({ envId: ENV_ID, frame: FRAME, principal: PRINCIPAL });
  });

  it('given NO principal (a connectivity bind), should refuse to send rather than sign under an invented identity', async () => {
    const transport = createLocalEnvTransport();

    await expect(transport.sendGrant({ envId: ENV_ID, frame: FRAME })).rejects.toBeInstanceOf(LocalEnvNoPrincipalError);
    expect(sendGrant).not.toHaveBeenCalled();
  });

  it('should report connected only for an AUTHORIZED socket (invariant 6)', () => {
    const transport = createLocalEnvTransport({ principal: PRINCIPAL });
    expect(transport.isConnected(ENV_ID)).toBe(false);

    getAuthorizedEnvConnection.mockReturnValue({});
    expect(transport.isConnected(ENV_ID)).toBe(true);
    expect(getAuthorizedEnvConnection).toHaveBeenLastCalledWith(ENV_ID);
  });

  it('should derive a connection epoch that is stable for one socket and different after a reconnect', () => {
    const transport = createLocalEnvTransport({ principal: PRINCIPAL });
    const socket = {};
    getAuthorizedEnvConnection.mockReturnValue(socket);
    getEnvConnectionMetadata.mockReturnValue({ sessionId: 'sess-1', connectedAt: new Date(1_700_000_000_000) });

    const first = transport.connectionEpoch(ENV_ID);
    expect(first).toBe('sess-1:1700000000000');
    expect(transport.connectionEpoch(ENV_ID)).toBe(first);

    getEnvConnectionMetadata.mockReturnValue({ sessionId: 'sess-2', connectedAt: new Date(1_700_000_009_000) });
    expect(transport.connectionEpoch(ENV_ID)).not.toBe(first);
  });

  it('given no socket, the epoch should be null — never a stale identity', () => {
    expect(createLocalEnvTransport({ principal: PRINCIPAL }).connectionEpoch(ENV_ID)).toBeNull();
  });
});

describe('exactly ONE verification path exists for env-bridge results', () => {
  const source = readFileSync(join(__dirname, '..', 'local-env-transport.ts'), 'utf8');

  it('should route through the shared bridge client rather than owning a socket', () => {
    expect(source).toContain('getEnvBridgeClient');
  });

  it.each(['signGrantFrame', 'verifyResultFromMachine', 'verifyMachineResult', 'encodeGrant', 'ed25519Verify', 'RequestCorrelator'])(
    'should NOT re-implement %s — it lives once, in the t07 bridge client',
    (banned) => {
      expect(source).not.toContain(banned);
    },
  );

  it('should be the only module besides the bridge client that verifies a machine result', () => {
    // `verifyResultFromMachine` is THE verifier. Exactly two production files
    // may name it: the one that defines it and the one that calls it. A third
    // means a result could be admitted by a path that has not kept up with the
    // first — the drift this whole module is shaped to prevent.
    const callers = grepProduction(join(__dirname, '..', '..', '..'), 'verifyResultFromMachine(');
    expect(callers).toEqual(['lib/env-bridge/bridge-client.ts', 'lib/env-bridge/result-verifier.ts']);
  });

  it('should have exactly one production grant SIGNER too — the same argument, the other direction', () => {
    const signers = grepProduction(join(__dirname, '..', '..', '..'), 'signGrantFrame(');
    expect(signers).toEqual(['lib/env-bridge/bridge-client.ts', 'lib/env-bridge/grant-signer.ts']);
  });
});

/** Every production (non-test) file under `src` whose text contains `needle`, repo-relative. */
function grepProduction(root: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === '__tests__' || entry === 'node_modules') continue;
        walk(full, `${prefix}${entry}/`);
      } else if (entry.endsWith('.ts') && readFileSync(full, 'utf8').includes(needle)) {
        found.push(`${prefix}${entry}`);
      }
    }
  };
  walk(root, '');
  return found.sort();
}
