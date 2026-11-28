/**
 * Spec X-1: "CLI and MCP expose orgs, members, drives, policies, and wallets where the web does."
 *
 * The parity guard. Every handler of every org, drive-org, join-request, policy and wallet web route
 * on disk must be exactly one of:
 *   - an SDK operation with the same method and path — hence an MCP tool (serve.ts derives the tool
 *     surface mechanically from this registry) — that a CLI verb calls; or
 *   - a row in the ONE exclusion table below, citing why a delegated key may not do it.
 * A new web route with neither fails here; an exclusion whose route is gone fails as stale; an
 * excluded route that also has an operation fails as contradictory.
 *
 * Exclusion classes (no others):
 *   - [D-OW-26]: an MCP/CLI key never moves money or changes a spend source, and reads wallet data
 *     only through the consumer allowlist — so wallet writes, seat caps (allocations), ownership
 *     transfer (the org's money authority) and the admin money views stay session-only;
 *   - billing: a Stripe action or the subscription (org delete ends it);
 *   - card-checkout create: creating an org needs a card ceremony in the browser;
 *   - image-file: the org avatar (ORG-1) is an image uploaded and served through the browser, which the
 *     SDK's JSON transport does not carry.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOperations } from '@pagespace/sdk';
import { buildOperationRegistry } from '../mcp/serve.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..', '..');
const API = join(REPO, 'apps', 'web', 'src', 'app', 'api');
const CLI_COMMANDS = join(HERE, '..', 'commands');

type Citation = 'D-OW-26' | 'billing' | 'card-checkout' | 'image-file';

/** The ONE exclusion table: `METHOD /api/...` (path params as `:param`) → why a key may not. */
const SESSION_ONLY: Record<string, { cite: Citation; why: string }> = {
  'POST /api/orgs': { cite: 'card-checkout', why: 'creating an org starts its subscription with a card in the browser' },
  'DELETE /api/orgs/:param': { cite: 'billing', why: 'deleting an org ends its Stripe subscription' },
  'POST /api/orgs/:param/avatar': { cite: 'image-file', why: 'uploads the avatar image (multipart)' },
  'DELETE /api/orgs/:param/avatar': { cite: 'image-file', why: 'removes the uploaded avatar image, the upload\'s counterpart' },
  'GET /api/orgs/:param/avatar/:param': { cite: 'image-file', why: 'serves the avatar image bytes to members' },
  'POST /api/orgs/:param/transfer-ownership': { cite: 'D-OW-26', why: 'the Owner holds the org\'s money authority (billing, pool, seat caps)' },
  'PUT /api/orgs/:param/members/:param/seat-cap': { cite: 'D-OW-26', why: 'a seat cap allocates org pool money to a member' },
  'DELETE /api/orgs/:param/members/:param/seat-cap': { cite: 'D-OW-26', why: 'clearing a seat cap re-allocates org pool money' },
  'GET /api/orgs/:param/seat-caps': { cite: 'D-OW-26', why: 'every member\'s remaining spend is an admin money view, outside the consumer allowlist' },
  'GET /api/orgs/:param/pool': { cite: 'D-OW-26', why: 'the org pool is an admin money view, outside the consumer allowlist' },
  'PATCH /api/orgs/:param/pool': { cite: 'D-OW-26', why: 'pausing or resuming the org pool changes what every seat and drive wallet under it may spend' },
  'GET /api/orgs/:param/billing/invoices': { cite: 'billing', why: 'Stripe invoices' },
  'POST /api/orgs/:param/billing/portal': { cite: 'billing', why: 'a Stripe billing-portal session' },
  'GET /api/orgs/:param/billing/seats': { cite: 'billing', why: 'the Stripe seat quantity' },
  'PATCH /api/orgs/:param/billing/seats': { cite: 'billing', why: 'changes the Stripe seat quantity' },
  'GET /api/orgs/:param/billing/storage': { cite: 'billing', why: 'the Stripe storage add-on quantity' },
  'PATCH /api/orgs/:param/billing/storage': { cite: 'billing', why: 'changes the Stripe storage add-on quantity (charges the org card)' },
  'POST /api/orgs/:param/billing/subscription': { cite: 'billing', why: 'starts or reactivates the Stripe subscription' },
  'POST /api/drives/:param/wallet': { cite: 'D-OW-26', why: 'creates (funds) a drive wallet' },
  'PATCH /api/drives/:param/wallet': { cite: 'D-OW-26', why: 'allocates, pauses or changes a drive wallet' },
  'DELETE /api/drives/:param/wallet': { cite: 'D-OW-26', why: 'deletes a drive wallet' },
  'POST /api/drives/:param/wallet/donate': { cite: 'D-OW-26', why: 'donates credits' },
  'POST /api/drives/:param/wallet/top-up': { cite: 'D-OW-26', why: 'tops a wallet up' },
  'GET /api/drives/:param/wallet/caps': { cite: 'D-OW-26', why: 'every person\'s caps are an admin money view; a key reads only the consumer view' },
  'PUT /api/drives/:param/wallet/caps/:param': { cite: 'D-OW-26', why: 'a consumer cap allocates wallet money' },
  'DELETE /api/drives/:param/wallet/caps/:param': { cite: 'D-OW-26', why: 'clearing a consumer cap re-allocates wallet money' },
  'PUT /api/wallets/default': { cite: 'D-OW-26', why: 'changes the personal default spend source' },
  'PUT /api/wallets/conversations/:param': { cite: 'D-OW-26', why: 'changes a conversation\'s spend source' },
  'PUT /api/wallets/always-own-credits': { cite: 'D-OW-26', why: 'changes which source every call spends from' },
};

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : routeFiles(path);
    return name === 'route.ts' ? [path] : [];
  });
}

const DRIVE = join(API, 'drives', '[driveId]');
const FILES = [
  ...routeFiles(join(API, 'orgs')),
  ...routeFiles(join(API, 'wallets')),
  ...routeFiles(join(DRIVE, 'org')),
  ...routeFiles(join(DRIVE, 'join-requests')),
  ...routeFiles(join(DRIVE, 'wallet')),
  // The drive list and create: create carries the org-owned drive (DRV-3), the list its org fields.
  join(API, 'drives', 'route.ts'),
];

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const routePath = (file: string) =>
  `/api/${relative(API, dirname(file)).split(sep).join('/')}`.replace(/\/$/, '').replace(/\[[^\]]+\]/g, ':param');
const WEB = FILES.flatMap((file) => {
  const source = readFileSync(file, 'utf8');
  return METHODS.filter((m) => new RegExp(`export\\s+(?:async\\s+function|function|const|let)\\s+${m}\\b`).test(source)).map(
    (m) => `${m} ${routePath(file)}`,
  );
});

const OPS = listOperations(buildOperationRegistry());
const opKey = (op: { method: string; path: string }) => `${op.method} ${op.path.replace(/:[A-Za-z]+/g, ':param')}`;
const OPS_BY_ROUTE = new Map<string, string[]>();
for (const op of OPS) OPS_BY_ROUTE.set(opKey(op), [...(OPS_BY_ROUTE.get(opKey(op)) ?? []), op.name]);

const CLI_SOURCE = readdirSync(CLI_COMMANDS)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => readFileSync(join(CLI_COMMANDS, name), 'utf8'))
  .join('\n');
/** `organizations.updatePolicies` is called by a verb as `sdk.organizations.updatePolicies(`. */
const hasCliVerb = (opName: string) => CLI_SOURCE.includes(`sdk.${opName}(`);

describe('X-1 every org, drive-org, policy and wallet web route has an SDK operation (hence MCP tool) and CLI verb, or a cited token exclusion', () => {
  it('X-1 the scan sees the whole surface', () => {
    expect(WEB.length).toBeGreaterThanOrEqual(70);
  });

  for (const route of WEB) {
    it(`X-1 ${route}`, () => {
      const ops = OPS_BY_ROUTE.get(route) ?? [];
      const excluded = SESSION_ONLY[route];
      if (excluded) {
        expect(ops, `${route} is session-only (${excluded.cite}) and must not be an operation`).toEqual([]);
        return;
      }
      expect(ops.length, `${route} needs an SDK operation or a cited exclusion`).toBe(1);
      expect(hasCliVerb(ops[0]), `${ops[0]} needs a CLI verb`).toBe(true);
    });
  }

  it('X-1 the exclusion table has no stale row: every excluded route still exists on disk', () => {
    expect(Object.keys(SESSION_ONLY).filter((route) => !WEB.includes(route))).toEqual([]);
  });
});
