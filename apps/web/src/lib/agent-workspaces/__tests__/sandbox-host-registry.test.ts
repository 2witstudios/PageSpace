/**
 * The kind-dispatching `SandboxHost` registry (M1 · t09).
 *
 * Two properties carry the safety here and both are negatives: a LOCAL
 * substrate must never reach the Sprite host, and a local host must never be
 * cached across requests (the transport it closes over is bound to one grant
 * principal, so a cached one would sign a second user's requests with the
 * first user's identity). A CONTROL row proves the harness genuinely does
 * reach the Sprite host, so "not called" means something.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const spriteHost = { provision: vi.fn(), attach: vi.fn(), kill: vi.fn() };
const getSandboxHost = vi.fn(async () => spriteHost);
vi.mock('../sandbox-host-runtime', () => ({ getSandboxHost: () => getSandboxHost() }));

const createLocalEnvTransport = vi.fn((_options?: unknown) => ({ sendGrant: vi.fn(), isConnected: () => true, connectionEpoch: () => 'epoch-1' }));
vi.mock('@/lib/sandbox/local-env-transport', () => ({ createLocalEnvTransport: (o?: unknown) => createLocalEnvTransport(o as never) }));

import { resolveSandboxHost, resolveSandboxHostForSandboxId } from '../sandbox-host-registry';
import { localEnvSandboxId } from '@pagespace/lib/services/sandbox/sandbox-host';

const PRINCIPAL = { userId: 'u1', sessionId: 'ws1', conversationId: 'c1' };
const ENV_ID = 'env-1';

beforeEach(() => vi.clearAllMocks());

describe('resolveSandboxHost', () => {
  it('given a sprite substrate, should return the process singleton — untouched by this task', async () => {
    expect(await resolveSandboxHost({ kind: 'sprite' }, PRINCIPAL)).toBe(spriteHost);
  });

  it('given a LOCAL substrate, should build a local host and NEVER consult the Sprite host', async () => {
    const host = await resolveSandboxHost({ kind: 'local', envId: ENV_ID }, PRINCIPAL);

    expect(host).not.toBe(spriteHost);
    expect(getSandboxHost).not.toHaveBeenCalled();
    expect(createLocalEnvTransport).toHaveBeenCalledWith({ principal: PRINCIPAL });
  });

  it('CONTROL: the same call with a sprite substrate DOES reach it — proving the negative above is load-bearing', async () => {
    await resolveSandboxHost({ kind: 'sprite' }, PRINCIPAL);
    expect(getSandboxHost).toHaveBeenCalledTimes(1);
  });

  it('should NOT process-cache a local host — a cached transport would sign one user\'s work under another\'s name', async () => {
    const first = await resolveSandboxHost({ kind: 'local', envId: ENV_ID }, PRINCIPAL);
    const second = await resolveSandboxHost({ kind: 'local', envId: ENV_ID }, { ...PRINCIPAL, userId: 'u2' });

    expect(first).not.toBe(second);
    expect(createLocalEnvTransport).toHaveBeenCalledTimes(2);
    expect(createLocalEnvTransport).toHaveBeenLastCalledWith({ principal: { ...PRINCIPAL, userId: 'u2' } });
  });

  it('given no principal (a connectivity bind), should build the transport WITHOUT one rather than inventing an identity', async () => {
    await resolveSandboxHost({ kind: 'local', envId: ENV_ID });
    expect(createLocalEnvTransport).toHaveBeenCalledWith({});
  });
});

describe('resolveSandboxHostForSandboxId', () => {
  it('given a local ADDRESS, should route to the local host', async () => {
    const host = await resolveSandboxHostForSandboxId(localEnvSandboxId(ENV_ID), PRINCIPAL);

    expect(host).not.toBe(spriteHost);
    expect(getSandboxHost).not.toHaveBeenCalled();
  });

  it('given a Sprite NAME, should route to the Sprite singleton — every id that is not a local address is one', async () => {
    expect(await resolveSandboxHostForSandboxId('pgs-env-abc123', PRINCIPAL)).toBe(spriteHost);
  });

  it('given a bare prefix with no env id, should NOT be treated as a local address', async () => {
    expect(await resolveSandboxHostForSandboxId('local-env:', PRINCIPAL)).toBe(spriteHost);
  });
});

describe('the existing Sprite consumers are untouched', () => {
  it('getSandboxHost should still be exported from its own runtime module and still answer the Sprite host', async () => {
    const runtime = await import('../sandbox-host-runtime');
    expect(await runtime.getSandboxHost()).toBe(spriteHost);
  });
});
