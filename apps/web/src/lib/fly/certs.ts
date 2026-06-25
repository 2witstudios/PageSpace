import type { FlyCertResponse } from '@pagespace/lib/canvas/cert-action';

const FLY_API_URL = 'https://api.fly.io/graphql';

// Fly's GraphQL `addCertificate` takes `appId` (an ID! whose value is the app
// NAME), NOT `appName` — passing `appName` is rejected with a schema error, so
// this mutation never succeeded until this was corrected.
const ADD_CERTIFICATE_MUTATION = `
  mutation AddCertificate($appId: ID!, $hostname: String!) {
    addCertificate(appId: $appId, hostname: $hostname) {
      certificate {
        configured
        clientStatus
        hostname
      }
    }
  }
`;

// Reading an existing cert's status uses `app(name:)` (a String!, not the ID!
// that addCertificate wants). Used when a cert already exists on the app.
const GET_CERTIFICATE_QUERY = `
  query GetCertificate($appName: String!, $hostname: String!) {
    app(name: $appName) {
      certificate(hostname: $hostname) {
        configured
        clientStatus
        hostname
      }
    }
  }
`;

// A Fly cert is live/servable when its clientStatus is "Ready". The boolean
// `configured` field only reflects DNS configuration, not issuance, so we key
// "active" off clientStatus.
const CERT_READY_STATUS = 'Ready';

type CertNode = { configured: boolean; clientStatus: string; hostname: string } | null;
type AddCertData = { addCertificate: { certificate: CertNode } | null };
type GetCertData = { app: { certificate: CertNode } | null };

async function flyGraphQL<T>(
  query: string,
  variables: Record<string, string>,
): Promise<{ data: T } | { error: string }> {
  const token = process.env.FLY_API_TOKEN ?? null;
  if (!token) {
    return { error: 'FLY_API_TOKEN is not configured' };
  }

  try {
    const response = await fetch(FLY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      let msg = `Fly API HTTP ${response.status}`;
      try {
        const body = (await response.json()) as { errors?: Array<{ message: string }> };
        if (body.errors?.[0]?.message) msg = body.errors[0].message;
      } catch {
        // ignore parse failure
      }
      return { error: msg };
    }

    const body = (await response.json()) as { data: T; errors?: Array<{ message: string }> };
    if (body.errors?.length) {
      return { error: body.errors.map((e) => e.message).join('; ') };
    }

    return { data: body.data };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Unknown Fly API error' };
  }
}

/** Map a Fly cert node to our response; `configured` means "Ready/live". */
function certToResponse(cert: CertNode): FlyCertResponse {
  if (!cert) return { ok: false, error: 'Fly did not return a certificate' };
  return { ok: true, configured: cert.clientStatus === CERT_READY_STATUS };
}

/**
 * Request a TLS certificate from Fly for the given hostname on the given app.
 *
 * Idempotent: if the cert already exists (Fly returns "Hostname already exists
 * on app"), that is NOT a failure — we read the existing cert's status instead,
 * so re-provision / poll cycles converge to active.
 */
export async function addCertificate(appName: string, hostname: string): Promise<FlyCertResponse> {
  const result = await flyGraphQL<AddCertData>(ADD_CERTIFICATE_MUTATION, { appId: appName, hostname });
  if ('error' in result) {
    if (/already exists/i.test(result.error)) {
      return getCertificate(appName, hostname);
    }
    return { ok: false, error: result.error };
  }
  return certToResponse(result.data.addCertificate?.certificate ?? null);
}

/** Read the status of an existing cert for a hostname on the given app. */
export async function getCertificate(appName: string, hostname: string): Promise<FlyCertResponse> {
  const result = await flyGraphQL<GetCertData>(GET_CERTIFICATE_QUERY, { appName, hostname });
  if ('error' in result) return { ok: false, error: result.error };
  return certToResponse(result.data.app?.certificate ?? null);
}
