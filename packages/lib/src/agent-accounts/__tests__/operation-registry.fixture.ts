/**
 * A small reviewed-looking `OperationRegistry` for tests (ADR 0004 §3.4
 * amendment M1). Production registries live with the provider catalogues
 * (G3); tests use this one so the operation a digest carries comes from a
 * registry match, exactly as it will in production — never from the request.
 * The `{slot}` names are the resource keys; their values come from the path.
 */
import type { CanonicalOrigin, OperationRegistry, OperationRegistryEntry } from '../canonical-request';

export const TEST_PROVIDER = 'github';
export const TEST_ORIGIN = 'https://api.github.com:443' as CanonicalOrigin;

/** The G1c fields every entry carries; an entry that binds nothing beyond its path uses these. */
export const ENTRY_DEFAULTS: Pick<OperationRegistryEntry, 'origin' | 'bodySlots' | 'derivedResources' | 'restrictionKeys' | 'auditResourceSlots'> = {
  origin: TEST_ORIGIN,
  bodySlots: [],
  derivedResources: [],
  restrictionKeys: {},
  auditResourceSlots: [],
};

export const TEST_REGISTRY: OperationRegistry = [
  {
    ...ENTRY_DEFAULTS,
    providerSlug: TEST_PROVIDER,
    channel: 'http-executor',
    method: 'POST',
    pathTemplate: '/repos/{owner}/{repo}/issues',
    operation: { class: 'write', name: 'github.issues.create' },
    declaredHeaders: ['x-github-api-version'],
  },
  {
    ...ENTRY_DEFAULTS,
    providerSlug: TEST_PROVIDER,
    channel: 'http-executor',
    method: 'GET',
    pathTemplate: '/repos/{owner}/{repo}/issues',
    operation: { class: 'read', name: 'github.issues.list' },
    declaredHeaders: [],
  },
  {
    ...ENTRY_DEFAULTS,
    providerSlug: TEST_PROVIDER,
    channel: 'http-executor',
    method: 'PUT',
    pathTemplate: '/repos/{owner}/{repo}/pulls/{number}/merge',
    operation: { class: 'irreversible', name: 'merge_pr' },
    declaredHeaders: [],
  },
  {
    ...ENTRY_DEFAULTS,
    providerSlug: TEST_PROVIDER,
    channel: 'http-executor',
    method: 'PUT',
    pathTemplate: '/repos/{owner}/{repo}/contents/{path}',
    operation: { class: 'write', name: 'github.contents.put' },
    declaredHeaders: [],
  },
  {
    ...ENTRY_DEFAULTS,
    providerSlug: TEST_PROVIDER,
    channel: 'http-executor',
    method: 'POST',
    pathTemplate: '/repos/{owner}/{repo}/tokens/{token}',
    operation: { class: 'privilege', name: 'github.tokens.use' },
    declaredHeaders: [],
  },
];
