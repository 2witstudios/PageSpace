/**
 * ADR 0004 §3.2/§3.4, §8.36–37 — registry slot matching specified in full
 * (G1c R17) and the registry keyed by origin with no null provider (G1c R7).
 *
 * Written RED before `lookup-operation.ts`, `bind-template-slots.ts`,
 * `find-operation-registry-conflicts.ts` and `find-registry-entry-defects.ts`
 * implement the amended rules (Control Board §7.2).
 */
import { describe, expect, it } from 'vitest';
import type { CanonicalOrigin, OperationRegistry, OperationRegistryEntry } from '../canonical-request';
import { lookupOperation } from '../lookup-operation';
import { findOperationRegistryConflicts } from '../find-operation-registry-conflicts';
import { findRegistryEntryDefects } from '../find-registry-entry-defects';
import { ENTRY_DEFAULTS, TEST_ORIGIN, TEST_PROVIDER } from './operation-registry.fixture';

const OTHER_ORIGIN = 'https://uploads.github.com:443' as CanonicalOrigin;

function entry(pathTemplate: string, name: string, overrides: Partial<OperationRegistryEntry> = {}): OperationRegistryEntry {
  return {
    ...ENTRY_DEFAULTS,
    providerSlug: TEST_PROVIDER,
    channel: 'http-executor',
    method: 'GET',
    pathTemplate,
    operation: { class: 'read', name },
    declaredHeaders: [],
    ...overrides,
  };
}

function lookup(registry: OperationRegistry, path: string, overrides: { providerSlug?: string | null; origin?: CanonicalOrigin } = {}) {
  return lookupOperation({
    registry,
    providerSlug: overrides.providerSlug === undefined ? TEST_PROVIDER : overrides.providerSlug,
    origin: overrides.origin ?? TEST_ORIGIN,
    channel: 'http-executor',
    method: 'GET',
    path,
  });
}

const nameOf = (registry: OperationRegistry, path: string, overrides: { providerSlug?: string | null; origin?: CanonicalOrigin } = {}) =>
  lookup(registry, path, overrides)?.entry.operation.name ?? null;

describe('lookupOperation — keyed by origin, never a null provider (G1c R7)', () => {
  const registry = [entry('/repos/{owner}/{repo}', 'repo.get')];

  it('given a request to the entry origin, should match; to any other origin, should match nothing', () => {
    const actual = [nameOf(registry, '/repos/a/b'), nameOf(registry, '/repos/a/b', { origin: OTHER_ORIGIN })];
    expect(actual).toEqual(['repo.get', null]);
  });

  it('given an account whose providerSlug is null, should match no entry — a generic origin never reaches a reviewed class', () => {
    const actual = nameOf(registry, '/repos/a/b', { providerSlug: null });
    expect(actual).toBeNull();
  });

  it('given a registry entry whose providerSlug is null at runtime (untyped data), should never match, whatever the account slug', () => {
    const nullProvider = { ...entry('/repos/{owner}/{repo}', 'null.provider'), providerSlug: null } as unknown as OperationRegistryEntry;
    const actual = [nameOf([nullProvider], '/repos/a/b'), nameOf([nullProvider], '/repos/a/b', { providerSlug: null })];
    expect(actual).toEqual([null, null]);
  });
});

describe('lookupOperation — slot matching (G1c R17)', () => {
  it('given a {name} slot, should match exactly one whole non-empty segment over the full path — no prefix, no trailing slash, no empty segment', () => {
    const registry = [entry('/repos/{owner}/{repo}/issues', 'issues')];
    const actual = ['/repos/a/b/issues', '/repos/a/b/issues/x', '/repos/a/b/issues/', '/repos//b/issues', '/repos/a/b'].map((path) => nameOf(registry, path));
    expect(actual).toEqual(['issues', null, null, null, null]);
  });

  it('given a path with an empty segment, should match no template — not even a multi-segment slot', () => {
    const registry = [entry('/repos/{owner}/{repo}/contents/{path+}', 'contents')];
    const actual = ['/repos/a/b/contents/x//y', '/repos/a/b/contents//', '/repos/a/b/contents/x/'].map((path) => nameOf(registry, path));
    expect(actual).toEqual([null, null, null]);
  });

  it('given a trailing {name+} slot, should bind one or more segments joined by /', () => {
    const registry = [entry('/repos/{owner}/{repo}/contents/{path+}', 'contents')];
    const actual = [lookup(registry, '/repos/a/b/contents/x')?.resources, lookup(registry, '/repos/a/b/contents/x/y/z')?.resources, lookup(registry, '/repos/a/b/contents')];
    expect(actual).toEqual([
      [
        ['owner', 'a'],
        ['path', 'x'],
        ['repo', 'b'],
      ],
      [
        ['owner', 'a'],
        ['path', 'x/y/z'],
        ['repo', 'b'],
      ],
      null,
    ]);
  });

  it('given a literal and a slot entry that both match, should pick the literal — never the first by order', () => {
    const literal = entry('/repos/acme/pulls', 'acme.pulls');
    const slot = entry('/repos/{owner}/pulls', 'any.pulls');
    const actual = [nameOf([slot, literal], '/repos/acme/pulls'), nameOf([literal, slot], '/repos/acme/pulls'), nameOf([slot, literal], '/repos/other/pulls')];
    expect(actual).toEqual(['acme.pulls', 'acme.pulls', 'any.pulls']);
  });

  it('given a {name} and a {name+} entry that both match, should pick the single-segment slot', () => {
    const single = entry('/files/{dir}/{name}', 'single');
    const multi = entry('/files/{dir}/{rest+}', 'multi');
    const actual = [nameOf([multi, single], '/files/a/b'), nameOf([multi, single], '/files/a/b/c')];
    expect(actual).toEqual(['single', 'multi']);
  });

  it('given specificity compared from the left, should let an earlier literal outrank a later one', () => {
    const early = entry('/a/lit/{x}', 'early');
    const late = entry('/a/{y}/lit', 'late');
    const actual = nameOf([late, early], '/a/lit/lit');
    expect(actual).toBe('early');
  });

  it('given two entries equally specific at every segment that both match, should resolve to no match (a load-time conflict)', () => {
    const one = entry('/repos/{owner}/{repo}', 'one');
    const two = entry('/repos/{org}/{name}', 'two');
    const actual = nameOf([one, two], '/repos/a/b');
    expect(actual).toBeNull();
  });

  it('given restrictionKeys, should emit each slot under its restriction key, sorted by key; an unmapped slot keeps its own name', () => {
    const registry = [entry('/repos/{owner}/{repo}', 'repo.get', { restrictionKeys: { repo: 'github.repo', owner: 'github.owner' } })];
    const mixed = [entry('/orgs/{org}/teams/{team}', 'team.get', { restrictionKeys: { team: 'github.team' } })];
    const actual = [lookup(registry, '/repos/a/b')?.resources, lookup(mixed, '/orgs/o/teams/t')?.resources];
    expect(actual).toEqual([
      [
        ['github.owner', 'a'],
        ['github.repo', 'b'],
      ],
      [
        ['github.team', 't'],
        ['org', 'o'],
      ],
    ]);
  });
});

describe('findOperationRegistryConflicts — only equal specificity conflicts (G1c R17)', () => {
  it('given a literal/slot pair, should report no conflict; given two entries of identical shape on one origin, should report it; on different origins, none', () => {
    const literal = entry('/repos/acme/pulls', 'acme.pulls');
    const slot = entry('/repos/{owner}/pulls', 'any.pulls');
    const twin = entry('/repos/{org}/pulls', 'twin.pulls');
    const elsewhere = entry('/repos/{org}/pulls', 'elsewhere.pulls', { origin: OTHER_ORIGIN });
    const actual = [
      findOperationRegistryConflicts({ registry: [literal, slot] }),
      findOperationRegistryConflicts({ registry: [slot, twin] }),
      findOperationRegistryConflicts({ registry: [slot, elsewhere] }),
    ];
    expect(actual).toEqual([[], [['/repos/{owner}/pulls', '/repos/{org}/pulls']], []]);
  });

  it('given two trailing multi-segment entries of the same shape, should report the conflict', () => {
    const one = entry('/files/{rest+}', 'one');
    const two = entry('/files/{path+}', 'two');
    const actual = findOperationRegistryConflicts({ registry: [one, two] });
    expect(actual).toEqual([['/files/{rest+}', '/files/{path+}']]);
  });
});

describe('findRegistryEntryDefects — templates and slots refused at load (G1c R17, R6)', () => {
  it('given malformed templates, should report each with its defect', () => {
    const registry = [
      entry('repos/{owner}', 'no.leading.slash'),
      entry('/repos//{owner}', 'empty.segment'),
      entry('/repos/{owner}/', 'trailing.slash'),
      entry('/files/{rest+}/tail', 'multi.not.last'),
      entry('/repos/{owner}/{owner}', 'duplicate.slot'),
      entry('/repos/{owner}', 'body.duplicates.path', { bodySlots: [{ slot: 'owner', pointer: ['owner'], shape: 'string' }] }),
      entry('/repos/{owner}', 'audit.undeclared', { auditResourceSlots: ['token'] }),
      entry('/repos/{owner}', 'restriction.undeclared', { restrictionKeys: { repo: 'github.repo' } }),
      entry('/repos/{owner}', 'fine', { auditResourceSlots: ['owner'], restrictionKeys: { owner: 'github.owner' } }),
    ];
    const actual = findRegistryEntryDefects({ registry }).map(({ operationName, defect }) => [operationName, defect]);
    expect(actual).toEqual([
      ['no.leading.slash', 'template_malformed'],
      ['empty.segment', 'template_malformed'],
      ['trailing.slash', 'template_malformed'],
      ['multi.not.last', 'multi_segment_slot_not_last'],
      ['duplicate.slot', 'duplicate_slot'],
      ['body.duplicates.path', 'duplicate_slot'],
      ['audit.undeclared', 'audit_slot_undeclared'],
      ['restriction.undeclared', 'restriction_key_for_undeclared_slot'],
    ]);
  });

  it('given a derived-resource rule on a non-relay entry, should report it', () => {
    const registry = [entry('/x', 'derived.off.relay', { derivedResources: [{ slot: 'branch', source: 'receive_pack_branches' }] })];
    const actual = findRegistryEntryDefects({ registry }).map(({ defect }) => defect);
    expect(actual).toEqual(['derived_resources_off_relay']);
  });
});
