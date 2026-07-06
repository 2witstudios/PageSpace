import { API_CONTRACT_VERSION } from '@pagespace/lib/api-contract-version';

/**
 * Public, DB-free handshake endpoint (ADR 0001 D2, docs/adr/0001-sdk-api-versioning.md).
 * The eager-handshake target — SDK/CLI clients call this before any operation
 * to render a compatibility verdict without waiting on a first real request.
 */
export async function GET(): Promise<Response> {
  return Response.json(
    { service: 'pagespace-web', apiVersion: API_CONTRACT_VERSION },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
