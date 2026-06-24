import type { FlyCertResponse } from '@pagespace/lib/canvas/cert-action';

const FLY_API_URL = 'https://api.fly.io/graphql';

const ADD_CERTIFICATE_MUTATION = `
  mutation AddCertificate($appName: ID!, $hostname: String!) {
    addCertificate(appName: $appName, hostname: $hostname) {
      certificate {
        configured
        hostname
      }
    }
  }
`;

const GET_CERTIFICATE_QUERY = `
  query GetCertificate($appName: String!, $hostname: String!) {
    app(name: $appName) {
      certificate(hostname: $hostname) {
        configured
        hostname
      }
    }
  }
`;

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

type AddCertData = {
  addCertificate: { certificate: { configured: boolean; hostname: string } };
};

type GetCertData = {
  app: { certificate: { configured: boolean; hostname: string } | null };
};

/** Request a TLS certificate from Fly for the given hostname on the given app. Idempotent. */
export async function addCertificate(appName: string, hostname: string): Promise<FlyCertResponse> {
  const result = await flyGraphQL<AddCertData>(ADD_CERTIFICATE_MUTATION, { appName, hostname });
  if ('error' in result) return { ok: false, error: result.error };
  const cert = result.data.addCertificate?.certificate;
  if (!cert) return { ok: false, error: 'Fly did not return a certificate' };
  return { ok: true, configured: cert.configured };
}

/** Fetch the current status of a Fly TLS certificate for the given hostname. */
export async function getCertificate(appName: string, hostname: string): Promise<FlyCertResponse> {
  const result = await flyGraphQL<GetCertData>(GET_CERTIFICATE_QUERY, { appName, hostname });
  if ('error' in result) return { ok: false, error: result.error };
  const cert = result.data.app?.certificate;
  if (!cert) return { ok: false, error: `Certificate not found for ${hostname}` };
  return { ok: true, configured: cert.configured };
}
