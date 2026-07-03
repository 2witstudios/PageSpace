import { describe, expect, it } from 'vitest';
import { AuthenticationError } from '../../errors.js';
import { StaticTokenProvider } from '../static.js';

const TOKEN = 'mcp_super_secret_value_12345';

describe('StaticTokenProvider', () => {
  it('resolves the configured token', async () => {
    const provider = new StaticTokenProvider(TOKEN);
    await expect(provider.getAccessToken()).resolves.toBe(TOKEN);
  });

  it('resolves the same token across repeated calls (no refresh capability)', async () => {
    const provider = new StaticTokenProvider(TOKEN);
    await provider.getAccessToken();
    await expect(provider.getAccessToken()).resolves.toBe(TOKEN);
  });

  it('fails closed with AuthenticationError after invalidate() — nothing to refresh into', async () => {
    const provider = new StaticTokenProvider(TOKEN);
    provider.invalidate();
    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('never exposes the token through default JSON serialization or string coercion', () => {
    const provider = new StaticTokenProvider(TOKEN);
    expect(JSON.stringify(provider)).not.toContain(TOKEN);
    expect(String(provider)).not.toContain(TOKEN);
  });
});
