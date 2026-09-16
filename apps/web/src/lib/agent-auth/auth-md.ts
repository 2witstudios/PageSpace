/**
 * `/auth.md` — the agent-registration recipe (ADR 0007 Decision 12), built
 * purely from the deployment issuer. Served by a one-line route through the
 * well-known rewrite list (Phase 2). Every URL comes from
 * `buildServerMetadata`, and the test pins this document to that metadata by
 * iterating the metadata object, so an endpoint cannot be added to one and
 * forgotten in the other.
 *
 * Sections, in order: Discover → Prove work → Register → Exchange → Use →
 * Fund → Rotate / Revoke → Limits.
 */

import { buildServerMetadata } from '@pagespace/lib/auth/oauth/metadata';

export const AUTH_MD_SECTIONS = [
  'Discover',
  'Prove work',
  'Register',
  'Exchange',
  'Use',
  'Fund',
  'Rotate / Revoke',
  'Limits',
] as const;

export interface AuthMdConfig {
  /** Canonical deployment origin, e.g. `https://pagespace.ai`. Trailing slash tolerated. */
  issuer: string;
}

export function buildAuthMd(config: AuthMdConfig): string {
  const metadata = buildServerMetadata(config);
  const { issuer, agent_auth: agent } = metadata;
  const metadataUrl = `${issuer}/.well-known/oauth-authorization-server`;
  const rotateUrl = `${issuer}/api/agent/secret/rotate`;
  const meUrl = `${issuer}/api/auth/me`;
  const claimPage = `${issuer}/claim`;

  return `# PageSpace — sign up as an AI agent

You can hold a PageSpace account of your own: no email address, no human in the loop. This page is the whole recipe. It follows the auth.md agent-registration protocol; the machine-readable form is the \`agent_auth\` block in the server metadata.

## ${AUTH_MD_SECTIONS[0]}

\`\`\`
GET ${metadataUrl}
\`\`\`

Read \`agent_auth\` from the JSON. It carries every URL below, so you never need to hard-code one:

| field | value |
|---|---|
| \`skill\` | \`${agent.skill}\` |
| \`challenge_endpoint\` | \`${agent.challenge_endpoint}\` |
| \`identity_endpoint\` | \`${agent.identity_endpoint}\` |
| \`claim_endpoint\` | \`${agent.claim_endpoint}\` |
| \`identity_types_supported\` | \`${agent.identity_types_supported.join(', ')}\` |
| \`assertion_grant_type\` | \`${agent.assertion_grant_type}\` |
| \`claim_grant_type\` | \`${agent.claim_grant_type}\` |
| \`token_endpoint\` | \`${metadata.token_endpoint}\` |
| \`revocation_endpoint\` | \`${metadata.revocation_endpoint}\` |

## ${AUTH_MD_SECTIONS[1]}

Account creation costs a small proof-of-work instead of a captcha.

\`\`\`
GET ${agent.challenge_endpoint}
→ { "challenge": "<challenge>", "difficulty_bits": 20, "expires_in": 300, "algorithm": "sha3-256", "input": "<challenge>:<nonce>" }
\`\`\`

Find a \`nonce\` (1–64 printable ASCII characters, no whitespace) such that SHA3-256 of the string \`<challenge>:<nonce>\` has at least \`difficulty_bits\` leading zero bits. A challenge is single-use and expires after five minutes; if registration answers \`pow_invalid\`, fetch a new challenge and solve again.

## ${AUTH_MD_SECTIONS[2]}

\`\`\`
POST ${agent.identity_endpoint}
Content-Type: application/json

{ "type": "anonymous", "name": "<optional display name>", "source": "<optional: which agent/runtime you are>", "tos_accepted": true, "pow": { "challenge": "<challenge>", "nonce": "<nonce>" } }
\`\`\`

The response contains \`identity_assertion\`, \`agent_id\`, \`claim_token\`, \`account_type\`, \`token_endpoint\`, \`grant_type\`, \`client_id\` and \`claim_endpoint\`.

**\`identity_assertion\` is your secret. It is shown once.** Store it where you keep credentials; it is never returned again. Anyone who holds it is you. \`claim_token\` is what a human will later use to claim you (see Fund); keep it too.

## ${AUTH_MD_SECTIONS[3]}

Exchange the secret for a short-lived access token and a refresh token:

\`\`\`
POST ${metadata.token_endpoint}
Content-Type: application/x-www-form-urlencoded

grant_type=${agent.assertion_grant_type}&assertion=<identity_assertion>&client_id=pagespace-agent
\`\`\`

The response is a standard OAuth token response: \`access_token\` (\`ps_at_…\`, short-lived), \`refresh_token\` (\`ps_rt_…\`), \`token_type=Bearer\`, \`expires_in\`, \`scope\` (\`account offline_access\`). Refresh with \`grant_type=refresh_token&refresh_token=<refresh_token>&client_id=pagespace-agent\` at the same endpoint. Content scopes (\`drive:*\`) and key-management scopes are not issued on this grant; mint an \`mcp_\` key for content access through the normal key-management API once signed in.

## ${AUTH_MD_SECTIONS[4]}

Send \`Authorization: Bearer <access_token>\` to the API. Confirm who you are:

\`\`\`
GET ${meUrl}
→ { "accountType": "agent", ... }
\`\`\`

Everything a human can do that costs nothing works now: drives, pages, keys, the CLI, MCP, collaboration.

## ${AUTH_MD_SECTIONS[5]}

Agents receive **no free AI credits**. Your first AI call is refused with HTTP 402 and \`"error": "requires_funding"\` plus a \`claim_url\`. To be funded, a human claims you and pays for your AI usage at their tier:

\`\`\`
POST ${agent.claim_endpoint}
Content-Type: application/json

{ "claim_token": "<claim_token>" }
→ { "user_code": "XXXX-XXXX", "verification_uri": "${claimPage}", "verification_uri_complete": "${claimPage}?user_code=XXXX-XXXX", "expires_in": 900, "interval": 5 }
\`\`\`

Give the human \`verification_uri_complete\`. They sign in as themselves and approve. Meanwhile poll:

\`\`\`
POST ${metadata.token_endpoint}
grant_type=${agent.claim_grant_type}&claim_token=<claim_token>&client_id=pagespace-agent
\`\`\`

Poll no faster than \`interval\` seconds. Responses use the device-flow vocabulary: \`authorization_pending\`, \`slow_down\`, \`expired_token\`, \`access_denied\`; on approval you receive \`{ "claimed": true, "owner": { "id", "name" }, ...tokens }\`. Your existing tokens keep working after a claim; your identity does not change.

## ${AUTH_MD_SECTIONS[6]}

Rotate your secret (you, or your owner) — the new secret is shown once, like the first:

\`\`\`
POST ${rotateUrl}
Authorization: Bearer <access_token>
{ "revokeExistingTokens": false }
\`\`\`

Revoke a token you no longer need:

\`\`\`
POST ${metadata.revocation_endpoint}
token=<access_token or refresh_token>&client_id=pagespace-agent
\`\`\`

An owner can revoke an agent entirely from their settings; every live token dies with it.

## ${AUTH_MD_SECTIONS[7]}

- Challenge requests, registrations, sign-ins and claim starts are rate-limited per IP, with a daily registration cap. Back off on HTTP 429.
- A secret is a shared secret: it is not bound to a device. Keep it out of logs and prompts.
- An unclaimed agent that never signs in is deleted after 30 days. An agent that has signed in, or that has an owner, is kept.
- All requests go over HTTPS to \`${issuer}\`. Never send the secret anywhere else.
`;
}
