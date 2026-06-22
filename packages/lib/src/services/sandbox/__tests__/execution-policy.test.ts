import { describe, it, expect } from 'vitest';
import {
  SANDBOX_EGRESS_ALLOWLIST,
  SANDBOX_TIMEOUT_MS,
  SANDBOX_MAX_OUTPUT_BYTES,
} from '../execution-policy';

describe('SANDBOX_EGRESS_ALLOWLIST', () => {
  it('should include GitHub hosts for git clone, API, and releases', () => {
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('github.com');
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('api.github.com');
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('raw.githubusercontent.com');
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('objects.githubusercontent.com');
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('uploads.github.com');
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('codeload.github.com');
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('github-releases.githubusercontent.com');
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('release-assets.githubusercontent.com');
  });

  it('should include npm/bun registry', () => {
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('registry.npmjs.org');
  });

  it('should include PyPI hosts', () => {
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('pypi.org');
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('files.pythonhosted.org');
  });

  it('should include Cargo/crates.io hosts', () => {
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('crates.io');
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('static.crates.io');
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('index.crates.io');
  });

  it('should include Go module proxy hosts', () => {
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('proxy.golang.org');
    expect(SANDBOX_EGRESS_ALLOWLIST).toContain('sum.golang.org');
  });

  it('should contain no wildcard entries', () => {
    for (const host of SANDBOX_EGRESS_ALLOWLIST) {
      expect(host).not.toContain('*');
    }
  });

  it('should be frozen so a caller cannot mutate it', () => {
    expect(() => {
      (SANDBOX_EGRESS_ALLOWLIST as unknown as string[]).push('evil.example.com');
    }).toThrow();
  });
});

describe('SANDBOX_TIMEOUT_MS', () => {
  it('should be a positive number', () => {
    expect(SANDBOX_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('should be 120 seconds', () => {
    expect(SANDBOX_TIMEOUT_MS).toBe(120_000);
  });
});

describe('SANDBOX_MAX_OUTPUT_BYTES', () => {
  it('should be a positive number', () => {
    expect(SANDBOX_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
  });

  it('should be 256 KB', () => {
    expect(SANDBOX_MAX_OUTPUT_BYTES).toBe(256 * 1024);
  });
});
