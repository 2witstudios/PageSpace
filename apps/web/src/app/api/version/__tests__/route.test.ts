import { describe, it, expect } from 'vitest';
import { API_CONTRACT_VERSION } from '@pagespace/lib/api-contract-version';
import { GET } from '../route';

describe('GET /api/version (ADR 0001 D2 — eager-handshake target)', () => {
  it('responds 200 with { service, apiVersion } equal to API_CONTRACT_VERSION', async () => {
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ service: 'pagespace-web', apiVersion: API_CONTRACT_VERSION });
  });

  it('does not cache the handshake response', async () => {
    const response = await GET();

    expect(response.headers.get('Cache-Control')).toBe('no-store, no-cache, must-revalidate');
  });
});
