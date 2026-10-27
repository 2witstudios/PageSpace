/**
 * The `@/lib/ai/tools/web-fetch-ssrf` barrel keeps the historical import path
 * for the web app now that the implementation lives in
 * `@pagespace/lib/security/web-fetch-ssrf`. A barrel that re-exports only the
 * value symbols is not a drop-in for the module it replaced: a caller that
 * annotates a decision with `FetchTargetDecision` fails to compile. Types are
 * erased at runtime, so the assertion that the type is re-exported is the
 * `import type` at the top of this file — `bun run typecheck` is what fails if
 * it is missing.
 */

import { describe, it, expect } from 'vitest';
import {
  isPublicIp,
  isAllowedFetchTarget,
  isIpLiteral,
  PRIVATE_HOST_MESSAGE,
  type FetchTargetDecision,
} from '@/lib/ai/tools/web-fetch-ssrf';

describe('web-fetch-ssrf barrel', () => {
  it('given the barrel, should re-export every value symbol the module had', () => {
    expect(typeof isPublicIp).toBe('function');
    expect(typeof isAllowedFetchTarget).toBe('function');
    expect(typeof isIpLiteral).toBe('function');
    expect(typeof PRIVATE_HOST_MESSAGE).toBe('string');
  });

  it('given a private target, should return a FetchTargetDecision refusing it', () => {
    const decision: FetchTargetDecision = isAllowedFetchTarget('https://169.254.169.254/latest/');
    expect(decision).toEqual({ ok: false, reason: PRIVATE_HOST_MESSAGE });
  });

  it('given a public target, should return a FetchTargetDecision allowing it', () => {
    const decision: FetchTargetDecision = isAllowedFetchTarget('https://example.com/');
    expect(decision.ok).toBe(true);
  });
});
