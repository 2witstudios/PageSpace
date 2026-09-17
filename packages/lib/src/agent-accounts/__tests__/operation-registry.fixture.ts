/**
 * A small reviewed-looking `OperationRegistry` for tests (ADR 0004 §3.4
 * amendment M1). Production registries live with the provider catalogues
 * (G3); tests use this one so the operation a digest carries comes from a
 * registry match, exactly as it will in production — never from the request.
 * The `{slot}` names are the resource keys; their values come from the path.
 */
import type { OperationRegistry } from '../canonical-request';

export const TEST_PROVIDER = 'github';

export const TEST_REGISTRY: OperationRegistry = [
  {
    providerSlug: TEST_PROVIDER,
    channel: 'http-executor',
    method: 'POST',
    pathTemplate: '/repos/{owner}/{repo}/issues',
    operation: { class: 'write', name: 'github.issues.create' },
    declaredHeaders: ['x-github-api-version'],
  },
  {
    providerSlug: TEST_PROVIDER,
    channel: 'http-executor',
    method: 'GET',
    pathTemplate: '/repos/{owner}/{repo}/issues',
    operation: { class: 'read', name: 'github.issues.list' },
    declaredHeaders: [],
  },
  {
    providerSlug: TEST_PROVIDER,
    channel: 'http-executor',
    method: 'PUT',
    pathTemplate: '/repos/{owner}/{repo}/pulls/{number}/merge',
    operation: { class: 'irreversible', name: 'merge_pr' },
    declaredHeaders: [],
  },
  {
    providerSlug: TEST_PROVIDER,
    channel: 'http-executor',
    method: 'PUT',
    pathTemplate: '/repos/{owner}/{repo}/contents/{path}',
    operation: { class: 'write', name: 'github.contents.put' },
    declaredHeaders: [],
  },
  {
    providerSlug: TEST_PROVIDER,
    channel: 'http-executor',
    method: 'POST',
    pathTemplate: '/repos/{owner}/{repo}/tokens/{token}',
    operation: { class: 'privilege', name: 'github.tokens.use' },
    declaredHeaders: [],
  },
];
