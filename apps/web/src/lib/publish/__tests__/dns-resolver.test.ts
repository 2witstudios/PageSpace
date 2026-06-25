import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Mock dns/promises.Resolver ───────────────────────────────────────────────
// Every method delegates to a module-level spy that receives the resolver's
// configured `servers`, so a test can branch on which resolver (public vs
// authoritative) issued each query and assert the authoritative path is used.

const PUBLIC_DNS = ['1.1.1.1', '8.8.8.8', '9.9.9.9'];

interface MockResolver {
  servers: string[];
  setServers(servers: string[]): void;
  resolveNs(domain: string): Promise<string[]>;
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  resolveCname(host: string): Promise<string[]>;
}

// vi.mock is hoisted above the module body, so the spies and the mock class
// must be created in a hoisted block they can both reference.
const { resolveNsImpl, resolve4Impl, resolve6Impl, resolveCnameImpl, instances, MockResolverCtor } =
  vi.hoisted(() => {
    const resolveNsImpl = vi.fn<(servers: string[], domain: string) => Promise<string[]>>();
    const resolve4Impl = vi.fn<(servers: string[], host: string) => Promise<string[]>>();
    const resolve6Impl = vi.fn<(servers: string[], host: string) => Promise<string[]>>();
    const resolveCnameImpl = vi.fn<(servers: string[], host: string) => Promise<string[]>>();
    const instances: MockResolver[] = [];

    class MockResolverCtor implements MockResolver {
      servers: string[] = [];
      constructor() {
        instances.push(this);
      }
      setServers(servers: string[]) {
        this.servers = servers;
      }
      getServers() {
        return this.servers;
      }
      resolveNs(domain: string) {
        return resolveNsImpl(this.servers, domain);
      }
      resolve4(host: string) {
        return resolve4Impl(this.servers, host);
      }
      resolve6(host: string) {
        return resolve6Impl(this.servers, host);
      }
      resolveCname(host: string) {
        return resolveCnameImpl(this.servers, host);
      }
    }

    return { resolveNsImpl, resolve4Impl, resolve6Impl, resolveCnameImpl, instances, MockResolverCtor };
  });

vi.mock('dns/promises', () => ({
  Resolver: MockResolverCtor,
  default: { Resolver: MockResolverCtor },
}));

import { resolveHostname } from '../dns-resolver';

const isPublic = (servers: string[]) => PUBLIC_DNS.every((s) => servers.includes(s)) && servers.length === PUBLIC_DNS.length;

beforeEach(() => {
  instances.length = 0;
  resolveNsImpl.mockReset();
  resolve4Impl.mockReset();
  resolve6Impl.mockReset();
  resolveCnameImpl.mockReset();
});

describe('resolveHostname — authoritative DNS', () => {
  it('queries the authoritative nameservers (not the public resolver) for the target', async () => {
    const NS_IPS = ['9.9.9.1', '9.9.9.2'];
    resolveNsImpl.mockResolvedValue(['ns1.registrar-servers.com', 'ns2.registrar-servers.com']);
    resolve4Impl.mockImplementation(async (servers, host) => {
      if (host === 'ns1.registrar-servers.com') return ['9.9.9.1'];
      if (host === 'ns2.registrar-servers.com') return ['9.9.9.2'];
      if (host === 'jonowoodall.com') {
        // The bug: the public/stale resolver still returns the OLD parking IP,
        // while the authoritative NS already serve the correct new edge IP.
        return isPublic(servers) ? ['192.64.119.23'] : ['137.66.4.209'];
      }
      return [];
    });
    resolve6Impl.mockResolvedValue([]);
    resolveCnameImpl.mockResolvedValue([]);

    const result = await resolveHostname('jonowoodall.com');

    // Source of truth — the authoritative answer, not the stale parking IP.
    expect(result.a).toEqual(['137.66.4.209']);

    // A resolver was pointed at the authoritative NS IPs and used for the target.
    const authResolver = instances.find((r) => r.servers.length === 2 && r.servers.includes('9.9.9.1') && r.servers.includes('9.9.9.2'));
    expect(authResolver).toBeDefined();
    expect(resolve4Impl).toHaveBeenCalledWith(NS_IPS, 'jonowoodall.com');

    // The NS lookup itself went through the public resolver (never the local one).
    expect(resolveNsImpl).toHaveBeenCalledWith(PUBLIC_DNS, 'jonowoodall.com');
  });

  it('derives the registrable domain for a subdomain when looking up nameservers', async () => {
    resolveNsImpl.mockResolvedValue(['ns1.acme.com']);
    resolve4Impl.mockImplementation(async (_servers, host) => {
      if (host === 'ns1.acme.com') return ['5.5.5.5'];
      return [];
    });
    resolve6Impl.mockResolvedValue([]);
    resolveCnameImpl.mockResolvedValue(['drive.pagespace.site']);

    const result = await resolveHostname('www.acme.com');

    expect(resolveNsImpl).toHaveBeenCalledWith(PUBLIC_DNS, 'acme.com');
    expect(result.cname).toEqual(['drive.pagespace.site']);
    // Target queried through the authoritative resolver.
    expect(resolveCnameImpl).toHaveBeenCalledWith(['5.5.5.5'], 'www.acme.com');
  });

  it('falls back to the public resolver when the NS lookup fails', async () => {
    resolveNsImpl.mockRejectedValue(new Error('NXDOMAIN'));
    resolve4Impl.mockImplementation(async (servers, host) => {
      if (host === 'jonowoodall.com' && isPublic(servers)) return ['137.66.4.209'];
      return [];
    });
    resolve6Impl.mockResolvedValue([]);
    resolveCnameImpl.mockResolvedValue([]);

    const result = await resolveHostname('jonowoodall.com');

    expect(result.a).toEqual(['137.66.4.209']);
    // No authoritative resolver was usable, so the public resolver answered.
    expect(resolve4Impl).toHaveBeenCalledWith(PUBLIC_DNS, 'jonowoodall.com');
  });

  it('falls back to the public resolver when NS records resolve to no IPs', async () => {
    resolveNsImpl.mockResolvedValue(['ns1.registrar-servers.com']);
    resolve4Impl.mockImplementation(async (servers, host) => {
      if (host === 'ns1.registrar-servers.com') return []; // NS host has no A glue
      if (host === 'jonowoodall.com' && isPublic(servers)) return ['137.66.4.209'];
      return [];
    });
    resolve6Impl.mockResolvedValue([]);
    resolveCnameImpl.mockResolvedValue([]);

    const result = await resolveHostname('jonowoodall.com');

    expect(result.a).toEqual(['137.66.4.209']);
    expect(resolve4Impl).toHaveBeenCalledWith(PUBLIC_DNS, 'jonowoodall.com');
  });

  it('returns empty arrays when every lookup fails (never throws)', async () => {
    resolveNsImpl.mockRejectedValue(new Error('NXDOMAIN'));
    resolve4Impl.mockRejectedValue(new Error('timeout'));
    resolve6Impl.mockRejectedValue(new Error('timeout'));
    resolveCnameImpl.mockRejectedValue(new Error('timeout'));

    const result = await resolveHostname('broken.example.com');

    expect(result).toEqual({ a: [], aaaa: [], cname: [] });
  });

  it('a failure of one record type does not break the others', async () => {
    resolveNsImpl.mockResolvedValue(['ns1.registrar-servers.com']);
    resolve4Impl.mockImplementation(async (_servers, host) => {
      if (host === 'ns1.registrar-servers.com') return ['9.9.9.1'];
      if (host === 'jonowoodall.com') return ['137.66.4.209'];
      return [];
    });
    resolve6Impl.mockRejectedValue(new Error('no AAAA')); // AAAA fails
    resolveCnameImpl.mockResolvedValue(['drive.pagespace.site']);

    const result = await resolveHostname('jonowoodall.com');

    expect(result.a).toEqual(['137.66.4.209']);
    expect(result.aaaa).toEqual([]);
    expect(result.cname).toEqual(['drive.pagespace.site']);
  });
});
